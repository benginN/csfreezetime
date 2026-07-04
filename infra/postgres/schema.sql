-- mimari.md §5.2 — PostgreSQL çekirdek şeması (Faz 1 kapsamı).
-- Kapsam dışı: CREATE EXTENSION vector + round_narratives (Faz 3 / NLP;
-- postgres:16 imajında pgvector yok, o fazda pgvector/pgvector imajına geçilir).
-- RLS politikaları multi-tenant açılmadan önce eklenecek (yerel tek-org kurulum).

-- Kimlik ve organizasyon ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (                       -- multi-tenancy kökü
    org_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
    team_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    tag         TEXT,
    region      TEXT
);
-- parser, takımları clan adıyla upsert eder (demolardan team_clan_name)
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_key ON teams (name);

CREATE TABLE IF NOT EXISTS players (
    player_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    steam_id64      BIGINT UNIQUE NOT NULL,
    nickname        TEXT NOT NULL,
    current_team_id UUID REFERENCES teams(team_id),
    role            TEXT CHECK (role IN ('igl','awp','entry','support','lurker','flex'))
);

-- Harita kalibrasyonu ve bölgeler ────────────────────────────────────
CREATE TABLE IF NOT EXISTS maps (
    map_name        TEXT PRIMARY KEY,      -- 'de_vertigo'
    radar_pos_x     REAL NOT NULL,
    radar_pos_y     REAL NOT NULL,
    radar_scale     REAL NOT NULL,
    has_lower_level BOOLEAN DEFAULT FALSE,
    level_split_z   REAL
);

CREATE TABLE IF NOT EXISTS map_areas (
    area_id     SERIAL PRIMARY KEY,
    map_name    TEXT REFERENCES maps(map_name),
    place_name  TEXT NOT NULL,             -- nav-mesh adı: 'RampA'
    aliases     TEXT[] NOT NULL,           -- {'A ramp','A rampası','ramp'}
    polygon     JSONB NOT NULL             -- [[x,y], ...] dünya koordinatı
);

-- Maç ve raunt ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
    match_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES orgs(org_id),   -- RLS anahtarı
    demo_sha256     TEXT UNIQUE NOT NULL,
    demo_object_key TEXT NOT NULL,         -- S3 yolu
    source          TEXT,                  -- 'scrim' | 'official' | 'faceit'
    event_name      TEXT,
    map_name        TEXT REFERENCES maps(map_name),
    team_a_id       UUID REFERENCES teams(team_id),
    team_b_id       UUID REFERENCES teams(team_id),
    score_a         SMALLINT, score_b SMALLINT,
    tick_rate       SMALLINT DEFAULT 64,
    played_at       TIMESTAMPTZ,
    tournament      TEXT,
    tick_purged     BOOLEAN NOT NULL DEFAULT false,
    is_private      BOOLEAN NOT NULL DEFAULT false,  -- kullanıcı özel DB'si: ready yerine private, ana arşive girmez  -- saklama: ham+tick silindi, meta kaldı  -- backfill arşiv adından; ml-jobs takım adlarını ayıklar
    parser_version  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status = ANY (ARRAY['queued','parsing','enriching','ready','failed','private']))
);

CREATE TABLE IF NOT EXISTS rounds (
    match_id        UUID REFERENCES matches(match_id) ON DELETE CASCADE,
    round_number    SMALLINT NOT NULL,
    start_tick      INT, freeze_end_tick INT, end_tick INT,
    winner_side     TEXT CHECK (winner_side IN ('T','CT')),
    end_reason      TEXT,                  -- bomb_exploded|defused|elimination|time
    bomb_plant_tick INT,
    bomb_site       TEXT,                  -- 'A' | 'B'
    t_team_id       UUID REFERENCES teams(team_id),  -- side swap çözümü
    ct_team_id      UUID REFERENCES teams(team_id),
    t_equip_value   INT, ct_equip_value INT,
    t_buy_type      TEXT CHECK (t_buy_type IN ('pistol','eco','semi','force','full')),
    ct_buy_type     TEXT CHECK (ct_buy_type IN ('pistol','eco','semi','force','full')),
    t_strategy_cluster  SMALLINT,          -- ML atar (§6.2), NULL = henüz yok
    ct_strategy_cluster SMALLINT,
    PRIMARY KEY (match_id, round_number)
);

-- Oyuncu-raunt köprüsü: ekonomi + raunt içi özet ─────────────────────
CREATE TABLE IF NOT EXISTS player_round_states (
    match_id     UUID,
    round_number SMALLINT,
    player_id    UUID REFERENCES players(player_id),
    side         TEXT CHECK (side IN ('T','CT')),
    money_start  INT, money_spent INT, equip_value INT,
    survived     BOOLEAN,
    kills SMALLINT, deaths SMALLINT, assists SMALLINT,
    damage_dealt SMALLINT, flash_assists SMALLINT,
    util_he_dmg SMALLINT NOT NULL DEFAULT 0, util_fire_dmg SMALLINT NOT NULL DEFAULT 0, -- utility hasar ayrımı
    PRIMARY KEY (match_id, round_number, player_id),
    FOREIGN KEY (match_id, round_number)
        REFERENCES rounds(match_id, round_number) ON DELETE CASCADE
);

-- Düşük hacimli olaylar ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kills (
    kill_id       BIGSERIAL PRIMARY KEY,
    match_id      UUID, round_number SMALLINT,
    tick          INT, round_time REAL,     -- freeze sonrası saniye
    attacker_id   UUID, victim_id UUID, assister_id UUID,
    weapon        TEXT,
    headshot BOOLEAN, wallbang BOOLEAN, noscope BOOLEAN,
    through_smoke BOOLEAN, attacker_blind BOOLEAN, victim_blind BOOLEAN,
    attacker_x REAL, attacker_y REAL, attacker_z REAL,
    victim_x   REAL, victim_y   REAL, victim_z   REAL,
    attacker_place TEXT, victim_place TEXT,
    is_first_kill BOOLEAN,                  -- rauntun açılış kill'i
    is_trade      BOOLEAN,                  -- enrichment hesaplar
    trade_time_ms INT,                      -- takım arkadaşı ölümünden bu kill'e
    FOREIGN KEY (match_id, round_number)
        REFERENCES rounds(match_id, round_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS kills_match_round_idx ON kills (match_id, round_number);
CREATE INDEX IF NOT EXISTS kills_attacker_idx ON kills (attacker_id);
CREATE INDEX IF NOT EXISTS kills_victim_idx ON kills (victim_id);

CREATE TABLE IF NOT EXISTS grenades (
    grenade_id    BIGSERIAL PRIMARY KEY,
    match_id      UUID, round_number SMALLINT,
    thrower_id    UUID, side TEXT,
    type          TEXT CHECK (type IN ('flash','smoke','he','molotov','incendiary','decoy')),
    throw_tick INT, detonate_tick INT, round_time_throw REAL,
    throw_x REAL, throw_y REAL, throw_z REAL,
    det_x   REAL, det_y   REAL, det_z   REAL,
    det_place TEXT,
    is_first_of_type_in_round BOOLEAN,      -- "ilk flash" sorguları için ön-hesap
    enemies_flashed SMALLINT, teammates_flashed SMALLINT,
    total_enemy_blind_time REAL,
    damage_dealt SMALLINT,
    FOREIGN KEY (match_id, round_number)
        REFERENCES rounds(match_id, round_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS grenades_match_round_idx ON grenades (match_id, round_number);
CREATE INDEX IF NOT EXISTS grenades_type_place_idx ON grenades (type, det_place);

-- Faz 4: yerel istatistik çıktıları (services/ml, ml-jobs yazar) ─────
CREATE TABLE IF NOT EXISTS strategy_clusters (
    map_name    TEXT NOT NULL,
    side        TEXT NOT NULL CHECK (side IN ('T','CT')),
    cluster_id  SMALLINT NOT NULL,
    label       TEXT,                      -- koç isimlendirmesi (insan döngüde)
    size        INT NOT NULL,
    top_places  JSONB NOT NULL,
    representatives JSONB NOT NULL,        -- merkeze en yakın rauntlar
    computed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (map_name, side, cluster_id)
);

CREATE TABLE IF NOT EXISTS team_tendencies (
    team_id     UUID REFERENCES teams(team_id),
    map_name    TEXT NOT NULL,
    side        TEXT NOT NULL CHECK (side IN ('T','CT')),
    cluster_id  SMALLINT NOT NULL,
    observed    INT NOT NULL,
    sample_size INT NOT NULL,
    shrunk_prob REAL NOT NULL,             -- Bayesçi büzülmeli olasılık (§6.2)
    computed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (team_id, map_name, side, cluster_id)
);

CREATE TABLE IF NOT EXISTS anomaly_flags (
    flag_id       BIGSERIAL PRIMARY KEY,
    player_id     UUID REFERENCES players(player_id),
    match_id      UUID REFERENCES matches(match_id) ON DELETE CASCADE,
    metric        TEXT NOT NULL,
    value         REAL NOT NULL,
    baseline_mean REAL NOT NULL,
    baseline_std  REAL NOT NULL,
    z             REAL NOT NULL,
    computed_at   TIMESTAMPTZ DEFAULT now()
);

-- Seed ───────────────────────────────────────────────────────────────
-- Faz 1 tek-org yerel kurulum; sabit UUID, worker'lar env'den değil buradan bilir.
INSERT INTO orgs (org_id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default')
ON CONFLICT (org_id) DO NOTHING;

-- Aktif harita havuzu; radar kalibrasyonu (§4.5) overview meta verilerinden.
-- ancient/anubis/dust2/mirage/nuke/overpass gerçek maç verisiyle doğrulandı
-- (tüm pozisyonlar [0,1024] radar aralığında); inferno/train/vertigo henüz
-- verisiz, ilk demo işlendiğinde doğrulanmalı.
INSERT INTO maps (map_name, radar_pos_x, radar_pos_y, radar_scale, has_lower_level, level_split_z) VALUES
    ('de_ancient',  -2953, 2164, 5.00,  FALSE, NULL),
    ('de_anubis',   -2796, 3328, 5.22,  FALSE, NULL),
    ('de_dust2',    -2476, 3239, 4.40,  FALSE, NULL),
    ('de_inferno',  -2087, 3870, 4.90,  FALSE, NULL),
    ('de_mirage',   -3230, 1713, 5.00,  FALSE, NULL),
    ('de_nuke',     -3453, 2887, 7.00,  TRUE,  -495),
    ('de_overpass', -4831, 1781, 5.20,  FALSE, NULL),
    ('de_train',    -2308, 2078, 4.082, FALSE, NULL),
    ('de_vertigo',  -3168, 1762, 4.00,  TRUE,  11700)
ON CONFLICT (map_name) DO NOTHING;

-- Execute şablonları (ml/templates.py): ilk 25 sn utility kümesi → site/kazanç
CREATE TABLE IF NOT EXISTS team_exec_templates (
    template_id SERIAL PRIMARY KEY,
    team_id     UUID REFERENCES teams(team_id) ON DELETE CASCADE,
    map_name    TEXT NOT NULL,
    pattern     JSONB NOT NULL,
    n           INT NOT NULL,
    wins        INT NOT NULL,
    site_mix    JSONB NOT NULL,
    computed_at TIMESTAMPTZ DEFAULT now()
);
