#!/usr/bin/env bash
# Mac -> sunucu veri taşıma. Mac'te çalıştırılır: deploy/migrate-from-mac.sh <ip>
# Ön koşul: sunucuda setup-server.sh bitmiş olmalı (infra ayakta, şemalar uygulanmış).
# İdempotent: mc mirror kaldığı yerden devam eder, pg_restore --clean tazeler.
set -euo pipefail

IP="${1:?kullanım: deploy/migrate-from-mac.sh <sunucu-ip>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a; source infra/.env; set +a

PGC_LOCAL="$(docker ps --format '{{.Names}}' | grep postgres | head -1)"

echo "== 1/5 web build + repo rsync"
npm --prefix apps/web run build
rsync -az --info=progress2 \
    --exclude 'services/parser-worker/target' --exclude node_modules \
    --exclude '.venv' --exclude '.git' \
    ./ "root@$IP:/opt/freezetime/"

echo "== 2/5 PG dump -> sunucu (UUID'ler, notlar, playlistler korunur)"
docker exec "$PGC_LOCAL" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
    > /tmp/freezetime-pg.dump
rsync -az --info=progress2 /tmp/freezetime-pg.dump "root@$IP:/tmp/"
ssh "root@$IP" bash -s <<'EOF'
set -e
PGC="$(docker ps --format '{{.Names}}' | grep postgres | head -1)"
source /opt/freezetime/infra/.env
docker exec -i "$PGC" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --clean --if-exists --no-owner < /tmp/freezetime-pg.dump
echo "pg_restore tamam"
EOF

echo "== 3/5 MinIO raw kovası aynalanıyor (~200 GB — saatler sürer, kesilirse aynı komut devam eder)"
command -v mc >/dev/null || brew install minio-mc
ssh -f -N -o ExitOnForwardFailure=yes -L 9101:localhost:9100 "root@$IP"
mc alias set ftlocal  "http://localhost:9100" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc alias set ftremote "http://localhost:9101" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mirror --preserve "ftlocal/$S3_BUCKET" "ftremote/$S3_BUCKET"

echo "== 4/5 servisler yeniden başlatılıyor (yeni kod + veri)"
ssh "root@$IP" 'systemctl restart freezetime-stats freezetime-enrichment "freezetime-parser@1" "freezetime-parser@2" "freezetime-parser@3" "freezetime-parser@4"'

echo "== 5/5 tam reprocess tetikleniyor (CH sunucuda yeniden kurulur, ~2 saat)"
ssh "root@$IP" "curl -s -X POST localhost:8090/api/v1/reprocess \
    -H \"X-Admin-Token: \$(grep '^ADMIN_TOKEN=' /opt/freezetime/infra/.env | cut -d= -f2)\" \
    -H 'Content-Type: application/json' -d '{}'"
echo
echo "TAŞIMA BAŞLATILDI. İlerleme: ssh root@$IP \"docker exec \\\$(docker ps --format '{{.Names}}' | grep postgres | head -1) psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc \\\"SELECT status,count(*) FROM matches GROUP BY 1\\\"\""
