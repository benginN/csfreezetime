#!/usr/bin/env bash
# infra/clickhouse/init.sql'i çalışan konteynere uygular ve heatmap_grid'i
# player_ticks'ten backfill eder (MV yalnızca yeni insert'leri gördüğünden).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/infra/.env"; set +a

CH() {
    docker compose -f "$ROOT/infra/docker-compose.yml" exec -T clickhouse \
        clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -mn --query "$1"
}

echo "şema uygulanıyor..."
docker compose -f "$ROOT/infra/docker-compose.yml" exec -T clickhouse \
    clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -mn \
    < "$ROOT/infra/clickhouse/init.sql"

echo "heatmap_grid backfill..."
CH "TRUNCATE TABLE cs2.heatmap_grid"
CH "INSERT INTO cs2.heatmap_grid
    SELECT map_name, side, match_id, round_number,
           toUInt16(floor(round_time)), toInt16(intDiv(toInt32(x),16)),
           toInt16(intDiv(toInt32(y),16)), count()
    FROM cs2.player_ticks WHERE is_alive
    GROUP BY map_name, side, match_id, round_number,
             toUInt16(floor(round_time)), toInt16(intDiv(toInt32(x),16)),
             toInt16(intDiv(toInt32(y),16))"

echo "sağlama:"
CH "SELECT (SELECT sum(presence) FROM cs2.heatmap_grid) AS grid_presence,
           (SELECT count() FROM cs2.player_ticks WHERE is_alive) AS alive_ticks,
           grid_presence = alive_ticks AS ok"
