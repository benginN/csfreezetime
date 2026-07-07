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
-- recency_score: zaman-azalımlı ağırlık toplamı (ml/recency.py, 90 gün yarı
-- ömür) — sunum sorgusu (report.go) top-N'i n yerine bununla sıralar, ham
-- hacim değil son eğilim öne çıksın diye. n/wins ham (ağırlıksız) kalır.
CREATE TABLE IF NOT EXISTS team_exec_templates (
    template_id    SERIAL PRIMARY KEY,
    team_id        UUID REFERENCES teams(team_id) ON DELETE CASCADE,
    map_name       TEXT NOT NULL,
    pattern        JSONB NOT NULL,
    n              INT NOT NULL,
    wins           INT NOT NULL,
    site_mix       JSONB NOT NULL,
    recency_score  REAL NOT NULL DEFAULT 0,
    computed_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE team_exec_templates ADD COLUMN IF NOT EXISTS recency_score REAL NOT NULL DEFAULT 0;

-- Tahmin değerlendirme meta'sı (evaluate.py): harita+taraf başına yöntem
-- yarışının sonucu. (DDL buraya sonradan eklendi — tablo canlıda elle
-- yaratılmıştı; IF NOT EXISTS + ALTER'lar idempotent tutar.)
CREATE TABLE IF NOT EXISTS prediction_meta (
    map_name          TEXT NOT NULL,
    side              TEXT NOT NULL,
    best_method       TEXT NOT NULL,
    logloss_league    REAL,
    logloss_team      REAL,
    logloss_team_buy  REAL,
    test_rounds       INT,
    PRIMARY KEY (map_name, side)
);
-- B1 rakip-özel kalibrasyon yöntemleri (2026-07-06)
ALTER TABLE prediction_meta ADD COLUMN IF NOT EXISTS logloss_team_vs    REAL;
ALTER TABLE prediction_meta ADD COLUMN IF NOT EXISTS logloss_team_style REAL;
-- LightGBM v2 adayı (2026-07-07, Faz D): yöntem yarışına lgbm sütunu +
-- kazandığı çiftlerde özellik önemleri (ML Lab şeffaflık paneli)
ALTER TABLE prediction_meta ADD COLUMN IF NOT EXISTS logloss_lgbm    REAL;
ALTER TABLE prediction_meta ADD COLUMN IF NOT EXISTS lgbm_importance JSONB;

-- LightGBM sunum tablosu: yalnız modelin zamansal sınavı KAZANDIĞI
-- (harita, taraf) çiftleri doldurulur; API best_method='lgbm' ise buradan
-- servis eder, yoksa büzülme zincirine düşer (ml/boost.py).
CREATE TABLE IF NOT EXISTS lgbm_predictions (
    team_id    UUID NOT NULL,
    map_name   TEXT NOT NULL,
    side       TEXT NOT NULL,
    buy_type   TEXT NOT NULL,
    cluster_id INT  NOT NULL,
    prob       REAL NOT NULL,
    n_eff      REAL NOT NULL,
    PRIMARY KEY (team_id, map_name, side, buy_type, cluster_id)
);

-- Rakip-kalibre eğilim sunum tablosu (evaluate.write_vs):
-- kind='vs'    → yalnız head-to-head rauntlardan (h2h_rounds ≥ 6)
-- kind='style' → hedef rakibe benzer profilli rakiplere karşı rauntların
--                benzerlik-ağırlıklı havuzundan
CREATE TABLE IF NOT EXISTS team_tendencies_vs (
    team_id     UUID NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    opp_team_id UUID NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    map_name    TEXT NOT NULL,
    side        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('vs','style')),
    cluster_id  INT  NOT NULL,
    h2h_rounds  INT  NOT NULL DEFAULT 0,
    prob        REAL NOT NULL,
    PRIMARY KEY (team_id, opp_team_id, map_name, side, kind, cluster_id)
);
CREATE INDEX IF NOT EXISTS ttv_lookup ON team_tendencies_vs (team_id, map_name, side, opp_team_id);

-- ============================================================================
-- Şema kayması onarımı (2026-07-08): aşağıdaki 11 tablo Temmuz sprintinde
-- canlı DB'ye elle ALTER/CREATE ile girmiş, schema.sql'e yazılmamıştı
-- (playlists/notes = işbirliği araçları; utility_spots/team_setups/
-- player_roles = Faz 5; winprob/clutches/rotations/cond = analitik).
-- DDL canlı veritabanından pg_dump ile çıkarıldı.
-- ============================================================================
CREATE TABLE IF NOT EXISTS clutches (
    match_id uuid NOT NULL,
    round_number smallint NOT NULL,
    player_id uuid,
    side text NOT NULL,
    versus smallint NOT NULL,
    start_sec real NOT NULL,
    won boolean NOT NULL,
    computed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT clutches_side_check CHECK ((side = ANY (ARRAY['T'::text, 'CT'::text])))
);
CREATE TABLE IF NOT EXISTS notes (
    note_id integer NOT NULL,
    match_id uuid,
    round_number smallint NOT NULL,
    t_sec real NOT NULL,
    author text DEFAULT ''::text,
    body text DEFAULT ''::text,
    audio_key text,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS notes_note_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE notes_note_id_seq OWNED BY notes.note_id;
CREATE TABLE IF NOT EXISTS player_roles (
    player_id uuid NOT NULL,
    team_id uuid,
    side text NOT NULL,
    map_name text NOT NULL DEFAULT '',  -- '' = tüm haritalar (genel profil)
    rounds integer NOT NULL,
    entry_attempt_share real,
    entry_success real,
    opening_kills integer,
    opening_deaths integer,
    lurk_dist_avg real,
    anchor_place text,
    anchor_share real,
    awp_round_share real,
    util_per_round real,
    flash_assists_pr real,
    adr real,
    tags text[] DEFAULT '{}'::text[],
    computed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT player_roles_side_check CHECK ((side = ANY (ARRAY['T'::text, 'CT'::text])))
);
CREATE TABLE IF NOT EXISTS playlist_items (
    item_id integer NOT NULL,
    playlist_id integer,
    match_id uuid,
    round_number smallint NOT NULL,
    t_sec real,
    note text,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS playlist_items_item_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE playlist_items_item_id_seq OWNED BY playlist_items.item_id;
CREATE TABLE IF NOT EXISTS playlists (
    playlist_id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS playlists_playlist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE playlists_playlist_id_seq OWNED BY playlists.playlist_id;
CREATE TABLE IF NOT EXISTS round_winprob (
    match_id uuid NOT NULL,
    round_number smallint NOT NULL,
    max_t_prob real NOT NULL,
    max_ct_prob real NOT NULL,
    computed_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS setup_rotations (
    team_id uuid NOT NULL,
    map_name text NOT NULL,
    side text NOT NULL,
    pattern_id smallint NOT NULL,
    place text NOT NULL,
    n_contacts integer NOT NULL,
    rotations integer NOT NULL,
    rotate_rate real NOT NULL,
    med_delay_sec real,
    dest_mix jsonb,
    computed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT setup_rotations_side_check CHECK ((side = ANY (ARRAY['T'::text, 'CT'::text])))
);
CREATE TABLE IF NOT EXISTS team_setups (
    team_id uuid NOT NULL,
    map_name text NOT NULL,
    side text NOT NULL,
    t_offset smallint NOT NULL,
    pattern_id smallint NOT NULL,
    pattern jsonb NOT NULL,
    observed integer NOT NULL,
    sample_size integer NOT NULL,
    share real NOT NULL,
    avg_hold_sec real,
    representatives jsonb,
    computed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT team_setups_side_check CHECK ((side = ANY (ARRAY['T'::text, 'CT'::text])))
);
CREATE TABLE IF NOT EXISTS team_tendencies_cond (
    team_id uuid NOT NULL,
    map_name text NOT NULL,
    side text NOT NULL,
    buy_type text NOT NULL,
    cluster_id smallint NOT NULL,
    observed integer NOT NULL,
    sample_size integer NOT NULL,
    prob real NOT NULL,
    computed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT team_tendencies_cond_buy_type_check CHECK ((buy_type = ANY (ARRAY['pistol'::text, 'eco'::text, 'semi'::text, 'force'::text, 'full'::text]))),
    CONSTRAINT team_tendencies_cond_side_check CHECK ((side = ANY (ARRAY['T'::text, 'CT'::text])))
);
CREATE TABLE IF NOT EXISTS utility_spots (
    team_id uuid NOT NULL,
    map_name text NOT NULL,
    side text NOT NULL,
    type text NOT NULL,
    cluster_id smallint NOT NULL,
    label text,
    det_rx real NOT NULL,
    det_ry real NOT NULL,
    throw_rx real,
    throw_ry real,
    count integer NOT NULL,
    share real NOT NULL,
    t_avg real,
    t_std real,
    strat_mix jsonb,
    representatives jsonb,
    computed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT utility_spots_side_check CHECK ((side = ANY (ARRAY['T'::text, 'CT'::text])))
);
CREATE TABLE IF NOT EXISTS winprob_table (
    alive_t smallint NOT NULL,
    alive_ct smallint NOT NULL,
    bomb boolean NOT NULL,
    tbucket smallint NOT NULL,
    t_wins integer NOT NULL,
    n integer NOT NULL,
    p real NOT NULL,
    computed_at timestamp with time zone DEFAULT now()
);
ALTER TABLE ONLY notes ALTER COLUMN note_id SET DEFAULT nextval('notes_note_id_seq'::regclass);
ALTER TABLE ONLY playlist_items ALTER COLUMN item_id SET DEFAULT nextval('playlist_items_item_id_seq'::regclass);
ALTER TABLE ONLY playlists ALTER COLUMN playlist_id SET DEFAULT nextval('playlists_playlist_id_seq'::regclass);
DO $$ BEGIN
    ALTER TABLE ONLY clutches ADD CONSTRAINT clutches_pkey PRIMARY KEY (match_id, round_number);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY notes ADD CONSTRAINT notes_pkey PRIMARY KEY (note_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY player_roles ADD CONSTRAINT player_roles_pkey PRIMARY KEY (player_id, side, map_name);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY playlist_items ADD CONSTRAINT playlist_items_pkey PRIMARY KEY (item_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY playlists ADD CONSTRAINT playlists_pkey PRIMARY KEY (playlist_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY round_winprob ADD CONSTRAINT round_winprob_pkey PRIMARY KEY (match_id, round_number);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY setup_rotations ADD CONSTRAINT setup_rotations_pkey PRIMARY KEY (team_id, map_name, side, pattern_id, place);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY team_setups ADD CONSTRAINT team_setups_pkey PRIMARY KEY (team_id, map_name, side, t_offset, pattern_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY team_tendencies_cond ADD CONSTRAINT team_tendencies_cond_pkey PRIMARY KEY (team_id, map_name, side, buy_type, cluster_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY utility_spots ADD CONSTRAINT utility_spots_pkey PRIMARY KEY (team_id, map_name, side, type, cluster_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY winprob_table ADD CONSTRAINT winprob_table_pkey PRIMARY KEY (alive_t, alive_ct, bomb, tbucket);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS notes_match_idx ON notes USING btree (match_id, round_number);
DO $$ BEGIN
    ALTER TABLE ONLY clutches ADD CONSTRAINT clutches_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY clutches ADD CONSTRAINT clutches_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(player_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY notes ADD CONSTRAINT notes_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY player_roles ADD CONSTRAINT player_roles_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(player_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY playlist_items ADD CONSTRAINT playlist_items_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY playlist_items ADD CONSTRAINT playlist_items_playlist_id_fkey FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY round_winprob ADD CONSTRAINT round_winprob_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY team_setups ADD CONSTRAINT team_setups_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(team_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY team_tendencies_cond ADD CONSTRAINT team_tendencies_cond_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(team_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ONLY utility_spots ADD CONSTRAINT utility_spots_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(team_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $$;
