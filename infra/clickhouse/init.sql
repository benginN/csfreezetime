-- mimari.md §5.3 — player_ticks (Faz 0 kapsamı; diğer tablolar Faz 1+)
-- Not: entrypoint init scriptleri CLICKHOUSE_DB'ye değil default'a bağlanır,
-- bu yüzden veritabanı adı (cs2, bkz. .env.example) açıkça yazılır.
CREATE TABLE IF NOT EXISTS cs2.player_ticks (
    match_id      UUID,
    map_name      LowCardinality(String),
    round_number  UInt8,
    tick          UInt32,
    round_time    Float32,                  -- freeze sonrası sn
    player_id     UUID,
    side          Enum8('T' = 1, 'CT' = 2),
    x Float32, y Float32, z Float32,
    yaw Float32, pitch Float32,             -- crosshair analizi için kritik
    velocity      Float32,
    health UInt8, armor UInt8,
    has_helmet UInt8 DEFAULT 0,  -- kask (HUD göstergesi)
    active_weapon LowCardinality(String),
    is_alive Bool, is_ducking Bool, is_walking Bool, is_scoped Bool,
    flash_remaining Float32,
    place         LowCardinality(String),   -- ingest'te atanır
    inventory     Array(String) DEFAULT []  -- eldeki tüm silahlar
) ENGINE = MergeTree
PARTITION BY map_name
ORDER BY (match_id, round_number, player_id, tick);

-- Isı haritası ön-agregatı (mimari.md §5.3 deseni; anahtara match_id +
-- round_number eklendi ki takım/buy/tarih filtreleri PG'den gelen raunt
-- listesiyle uygulanabilsin ve raunt sayısına normalizasyon (§8.2) mümkün olsun).
CREATE TABLE IF NOT EXISTS cs2.heatmap_grid (
    map_name     LowCardinality(String),
    side         Enum8('T' = 1, 'CT' = 2),
    match_id     UUID,
    round_number UInt8,
    time_bucket  UInt16,   -- freeze sonrası 1 sn kovası
    grid_x       Int16,    -- 16 birimlik dünya koordinat ızgarası
    grid_y       Int16,
    presence     UInt64
) ENGINE = SummingMergeTree
ORDER BY (map_name, side, match_id, round_number, time_bucket, grid_x, grid_y);

CREATE MATERIALIZED VIEW IF NOT EXISTS cs2.heatmap_grid_mv
TO cs2.heatmap_grid
AS SELECT
    map_name,
    side,
    match_id,
    round_number,
    toUInt16(floor(round_time))      AS time_bucket,
    toInt16(intDiv(toInt32(x), 16))  AS grid_x,
    toInt16(intDiv(toInt32(y), 16))  AS grid_y,
    count()                          AS presence
FROM cs2.player_ticks
WHERE is_alive
GROUP BY map_name, side, match_id, round_number, time_bucket, grid_x, grid_y;

-- Silah atışları (weapon_fire; bomba/bıçak hariç) — replay ateş animasyonu
CREATE TABLE IF NOT EXISTS cs2.shots (
    match_id     UUID,
    round_number UInt8,
    tick         UInt32,
    player_id    UUID
) ENGINE = MergeTree
ORDER BY (match_id, round_number, tick);

-- tick bazlı para (HUD canlı para göstergesi)
ALTER TABLE cs2.player_ticks ADD COLUMN IF NOT EXISTS money Int32 DEFAULT 0;
