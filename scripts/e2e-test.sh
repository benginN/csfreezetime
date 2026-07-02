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

pg_query() {
    docker compose -f "$ROOT/infra/docker-compose.yml" exec -T postgres \
        psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"
}

pg_table() {
    docker compose -f "$ROOT/infra/docker-compose.yml" exec -T postgres \
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"
}

# 1) Altyapı — minio-init one-shot olduğundan --wait'e dahil edilmez
# (compose, kod 0 ile çıkan servisi de "failed" sayıp 1 döndürüyor)
log "docker compose up --wait"
docker compose -f "$ROOT/infra/docker-compose.yml" up -d --wait postgres clickhouse minio nats
docker compose -f "$ROOT/infra/docker-compose.yml" up -d minio-init

# 1b) PG şeması (idempotent)
log "PG şeması uygulanıyor"
"$ROOT/scripts/apply-pg-schema.sh" >/dev/null

# 2) Worker'ları derle ve başlat
log "parser-worker derleniyor (cargo build --release)"
cargo build --release --manifest-path "$ROOT/services/parser-worker/Cargo.toml"

log "parser-worker başlatılıyor"
WORKER_LOG="$(mktemp -t parser-worker-log)"
"$ROOT/services/parser-worker/target/release/parser-worker" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

log "enrichment-worker başlatılıyor (uv run)"
ENRICH_LOG="$(mktemp -t enrichment-log)"
# --no-editable: python.org 3.13.0'da editable .pth işlenmiyor
(cd "$ROOT/services/enrichment" && uv run --no-editable --quiet enrichment-worker) >"$ENRICH_LOG" 2>&1 &
ENRICH_PID=$!

trap 'kill $WORKER_PID $ENRICH_PID 2>/dev/null || true' EXIT
sleep 2
kill -0 "$WORKER_PID" 2>/dev/null || { cat "$WORKER_LOG"; fail "parser-worker başlamadı"; }
kill -0 "$ENRICH_PID" 2>/dev/null || { cat "$ENRICH_LOG"; fail "enrichment-worker başlamadı"; }

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

# 5) Kanonik match_id'yi PG'den çöz (aynı demo tekrar işlenirse ilk id korunur)
log "kanonik match_id bekleniyor"
START_TS=$(date +%s)
while true; do
    CANONICAL="$(pg_query "SELECT match_id FROM matches WHERE demo_sha256 = '$SHA256'" || true)"
    [ -n "$CANONICAL" ] && break
    [ $(( $(date +%s) - START_TS )) -gt 60 ] && { tail -20 "$WORKER_LOG"; fail "matches satırı oluşmadı"; }
    sleep 2
done
[ "$CANONICAL" != "$MATCH_ID" ] && log "not: demo daha önce işlenmiş, kanonik id: $CANONICAL"
MATCH_ID="$CANONICAL"

# 6) ClickHouse'ta satırları bekle (sayı > 0 ve iki ölçümde sabit)
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

# 7) Enrichment'ın bitmesini bekle (matches.status = 'ready')
log "enrichment bekleniyor (matches.status='ready', timeout 120 sn)"
START_TS=$(date +%s)
while true; do
    STATUS="$(pg_query "SELECT status FROM matches WHERE match_id = '$MATCH_ID'")"
    [ "$STATUS" = "ready" ] && break
    if [ $(( $(date +%s) - START_TS )) -gt 120 ]; then
        echo "--- enrichment log ---"; tail -30 "$ENRICH_LOG"
        fail "timeout: status=$STATUS"
    fi
    kill -0 "$ENRICH_PID" 2>/dev/null || { tail -30 "$ENRICH_LOG"; fail "enrichment-worker öldü"; }
    sleep 2
done

# 8) Rapor + doğrulama
echo
log "===== SONUÇ ====="
log "player_ticks satır sayısı: $COUNT"
ch_query "SELECT map_name, count() AS rows, uniqExact(round_number) AS rounds, uniqExact(player_id) AS players FROM player_ticks WHERE match_id = '$MATCH_ID' GROUP BY map_name FORMAT PrettyCompact"
echo
log "PG rauntlar (buy sınıfları + ekipman değerleri):"
pg_table "SELECT round_number, winner_side, end_reason, bomb_site,
                 t_equip_value, t_buy_type, ct_equip_value, ct_buy_type
          FROM rounds WHERE match_id = '$MATCH_ID' ORDER BY round_number"
echo
log "PG kill/trade özeti:"
pg_table "SELECT count(*) AS kills,
                 count(*) FILTER (WHERE is_first_kill) AS first_kills,
                 count(*) FILTER (WHERE is_trade) AS trades,
                 round(avg(trade_time_ms) FILTER (WHERE is_trade)) AS avg_trade_ms
          FROM kills WHERE match_id = '$MATCH_ID'"
echo
log "PG tablo sayıları:"
pg_table "SELECT (SELECT count(*) FROM rounds   WHERE match_id = '$MATCH_ID') AS rounds,
                 (SELECT count(*) FROM kills    WHERE match_id = '$MATCH_ID') AS kills,
                 (SELECT count(*) FROM grenades WHERE match_id = '$MATCH_ID') AS grenades,
                 (SELECT count(*) FROM player_round_states WHERE match_id = '$MATCH_ID') AS prs,
                 (SELECT count(*) FROM players) AS players"
echo
log "worker özetleri:"
grep -E "parse tamam|PG meta veri|demo.parsed yayınlandı" "$WORKER_LOG" | tail -3
grep -E "enrichment tamam|demo.enriched" "$ENRICH_LOG" | tail -2

# Tutarlılık kontrolleri
PARSED_ROWS="$(grep -o 'rows=[0-9]*' "$WORKER_LOG" | tail -1 | cut -d= -f2 || true)"
if [ -n "${PARSED_ROWS:-}" ] && [ "$PARSED_ROWS" != "$COUNT" ]; then
    fail "tutarsızlık: worker $PARSED_ROWS satır dedi, ClickHouse'ta $COUNT var"
fi
FIRST_KILLS="$(pg_query "SELECT count(*) FILTER (WHERE is_first_kill) FROM kills WHERE match_id = '$MATCH_ID'")"
ROUNDS_WITH_KILLS="$(pg_query "SELECT count(DISTINCT round_number) FROM kills WHERE match_id = '$MATCH_ID'")"
if [ "$FIRST_KILLS" != "$ROUNDS_WITH_KILLS" ]; then
    fail "tutarsızlık: first_kills=$FIRST_KILLS != kill'li raunt sayısı=$ROUNDS_WITH_KILLS"
fi
BUY_NULLS="$(pg_query "SELECT count(*) FROM rounds WHERE match_id = '$MATCH_ID' AND (t_buy_type IS NULL OR ct_buy_type IS NULL)")"
if [ "$BUY_NULLS" != "0" ]; then
    log "UYARI: $BUY_NULLS rauntta buy_type NULL (ekonomi verisi eksik olabilir)"
fi

log "E2E TEST BAŞARILI ✅"
