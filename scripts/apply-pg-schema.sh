#!/usr/bin/env bash
# infra/postgres/schema.sql'i çalışan postgres konteynerine uygular (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/infra/.env"; set +a

docker compose -f "$ROOT/infra/docker-compose.yml" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    < "$ROOT/infra/postgres/schema.sql"

echo "Şema uygulandı. Tablolar:"
docker compose -f "$ROOT/infra/docker-compose.yml" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\dt'
