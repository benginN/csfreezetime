#!/usr/bin/env bash
# Faz 0 uçtan uca test: mac.dem -> MinIO -> demo.ingested -> parser-worker
# -> ClickHouse player_ticks. Çıkış kriteri (mimari.md §11): satırlar sorgulanabiliyor.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_FILE="${1:-$ROOT/test-data/mac.dem}"
COMPOSE_NET="cs2-platform_default"

# shellcheck disable=SC1091
set -a; source "$ROOT/infra/.env"; set +a

log() { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[e2e] HATA:\033[0m %s\n' "$*"; exit 1; }

[ -f "$DEMO_FILE" ] || fail "demo dosyası yok: $DEMO_FILE"

ch_query() {
    curl -s "http://localhost:8123/?user=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}&database=${CLICKHOUSE_DB}" --data "$1"
}

# 1) Altyapı — minio-init one-shot olduğundan --wait'e dahil edilmez
# (compose, kod 0 ile çıkan servisi de "failed" sayıp 1 döndürüyor)
log "docker compose up --wait"
docker compose -f "$ROOT/infra/docker-compose.yml" up -d --wait postgres clickhouse minio nats
docker compose -f "$ROOT/infra/docker-compose.yml" up -d minio-init

# 2) Worker'ı derle ve başlat
log "worker derleniyor (cargo build --release)"
cargo build --release --manifest-path "$ROOT/services/parser-worker/Cargo.toml"

log "worker başlatılıyor"
WORKER_LOG="$(mktemp -t parser-worker-log)"
"$ROOT/services/parser-worker/target/release/parser-worker" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null || true' EXIT
sleep 2
kill -0 "$WORKER_PID" 2>/dev/null || { cat "$WORKER_LOG"; fail "worker başlamadı"; }

# 3) Demoyu MinIO'ya yükle
SHA256="$(shasum -a 256 "$DEMO_FILE" | cut -d' ' -f1)"
OBJECT_KEY="raw/${SHA256}.dem"
MATCH_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
log "sha256=$SHA256 match_id=$MATCH_ID"

log "MinIO'ya yükleniyor: $OBJECT_KEY"
docker run --rm --network "$COMPOSE_NET" \
    -v "$(dirname "$DEMO_FILE"):/data:ro" \
    --entrypoint /bin/sh minio/mc:latest -c "
    mc alias set local http://minio:9000 '$MINIO_ROOT_USER' '$MINIO_ROOT_PASSWORD' >/dev/null &&
    mc cp /data/$(basename "$DEMO_FILE") local/$S3_BUCKET/$OBJECT_KEY"

# 4) demo.ingested olayını yayınla
PAYLOAD="{\"demo_sha256\":\"$SHA256\",\"match_id\":\"$MATCH_ID\",\"object_key\":\"$OBJECT_KEY\"}"
log "demo.ingested yayınlanıyor"
docker run --rm --network "$COMPOSE_NET" natsio/nats-box:latest \
    nats --server nats://nats:4222 pub demo.ingested "$PAYLOAD"

# 5) ClickHouse'ta satırları bekle (sayı > 0 ve iki ölçümde sabit)
log "ClickHouse player_ticks bekleniyor (timeout 300 sn)"
START_TS=$(date +%s)
PREV=0
while true; do
    COUNT="$(ch_query "SELECT count() FROM player_ticks WHERE match_id = '$MATCH_ID'")"
    ELAPSED=$(( $(date +%s) - START_TS ))
    if [ "${COUNT:-0}" -gt 0 ] && [ "$COUNT" = "$PREV" ]; then
        break
    fi
    if [ "$ELAPSED" -gt 300 ]; then
        echo "--- worker log ---"; tail -30 "$WORKER_LOG"
        fail "timeout: $ELAPSED sn sonra satır sayısı=$COUNT"
    fi
    kill -0 "$WORKER_PID" 2>/dev/null || { tail -30 "$WORKER_LOG"; fail "worker öldü"; }
    PREV="$COUNT"
    sleep 3
done

# 6) Rapor + doğrulama
echo
log "===== SONUÇ ====="
log "player_ticks satır sayısı: $COUNT"
ch_query "SELECT map_name, count() AS rows, uniqExact(round_number) AS rounds, uniqExact(player_id) AS players, min(tick) AS min_tick, max(tick) AS max_tick FROM player_ticks WHERE match_id = '$MATCH_ID' GROUP BY map_name FORMAT PrettyCompact"
echo
log "raunt dağılımı (ilk 10):"
ch_query "SELECT round_number, count() FROM player_ticks WHERE match_id = '$MATCH_ID' GROUP BY round_number ORDER BY round_number LIMIT 10 FORMAT PrettyCompact"
echo
log "worker parse özeti:"
grep -E "parse tamam|insert tamam|demo.parsed" "$WORKER_LOG" | tail -5

PARSED_ROWS="$(grep -o 'rows=[0-9]*' "$WORKER_LOG" | tail -1 | cut -d= -f2 || true)"
if [ -n "${PARSED_ROWS:-}" ] && [ "$PARSED_ROWS" != "$COUNT" ]; then
    fail "tutarsızlık: worker $PARSED_ROWS satır dedi, ClickHouse'ta $COUNT var"
fi

log "E2E TEST BAŞARILI ✅"
