#!/usr/bin/env bash
# test-data/ içindeki işlenmemiş .dem dosyalarını MinIO'ya yükleyip
# demo.ingested yayınlar (yerel mini ingest-svc; gerçeği Go ile gelecek, §9).
# Kullanım: scripts/ingest-dir.sh [klasör]   (varsayılan: test-data)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$ROOT/test-data}"
COMPOSE_NET="cs2-platform_default"

# shellcheck disable=SC1091
set -a; source "$ROOT/infra/.env"; set +a

log() { printf '\033[1;34m[ingest]\033[0m %s\n' "$*"; }

pg_query() {
    docker compose -f "$ROOT/infra/docker-compose.yml" exec -T postgres \
        psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"
}

QUEUED=0
for f in "$DIR"/*.dem; do
    [ -e "$f" ] || { log "demo bulunamadı: $DIR"; exit 0; }
    NAME="$(basename "$f")"
    SHA256="$(shasum -a 256 "$f" | cut -d' ' -f1)"
    STATUS="$(pg_query "SELECT status FROM matches WHERE demo_sha256 = '$SHA256'" || true)"
    if [ "$STATUS" = "ready" ]; then
        log "atlandı (zaten işlenmiş): $NAME"
        continue
    fi

    OBJECT_KEY="raw/${SHA256}.dem"
    MATCH_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    log "yükleniyor: $NAME ($(du -h "$f" | cut -f1 | tr -d ' '))"
    docker run --rm --network "$COMPOSE_NET" \
        -v "$(dirname "$f"):/data:ro" \
        --entrypoint /bin/sh minio/mc:latest -c "
        mc alias set local http://minio:9000 '$MINIO_ROOT_USER' '$MINIO_ROOT_PASSWORD' >/dev/null &&
        mc cp -q /data/$NAME local/$S3_BUCKET/$OBJECT_KEY >/dev/null"

    PAYLOAD="{\"demo_sha256\":\"$SHA256\",\"match_id\":\"$MATCH_ID\",\"object_key\":\"$OBJECT_KEY\",\"source_file\":\"$NAME\"}"
    docker run --rm --network "$COMPOSE_NET" natsio/nats-box:latest \
        nats --server nats://nats:4222 pub demo.ingested "$PAYLOAD" >/dev/null
    log "kuyruğa verildi: $NAME (match_id=$MATCH_ID)"
    QUEUED=$((QUEUED + 1))
done

log "toplam $QUEUED demo kuyruğa verildi"
