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
    active_weapon LowCardinality(String),
    is_alive Bool, is_ducking Bool, is_walking Bool, is_scoped Bool,
    flash_remaining Float32,
    place         LowCardinality(String)    -- ingest'te atanır
) ENGINE = MergeTree
PARTITION BY map_name
ORDER BY (match_id, round_number, player_id, tick);
