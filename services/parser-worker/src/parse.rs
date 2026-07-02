//! .dem baytları -> player_ticks satırları (mimari.md §4.3 Pass A + Pass B).

use ahash::AHashMap;
use anyhow::{anyhow, bail, Context, Result};
use parser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use parser::first_pass::prop_controller::{STEAMID_ID, TICK_ID};
use parser::parse_demo::{Parser, ParsingMode};
use parser::second_pass::parser_settings::create_huffman_lookup_table;
use parser::second_pass::variants::{PropColumn, VarVec, Variant};
use uuid::Uuid;

/// ClickHouse player_ticks satırı (şema: mimari.md §5.3, kolon sırası DDL ile birebir).
#[derive(Debug, clickhouse::Row, serde::Serialize)]
pub struct PlayerTickRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub match_id: Uuid,
    pub map_name: String,
    pub round_number: u8,
    pub tick: u32,
    pub round_time: f32,
    #[serde(with = "clickhouse::serde::uuid")]
    pub player_id: Uuid,
    pub side: i8, // Enum8: T=1, CT=2
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub velocity: f32,
    pub health: u8,
    pub armor: u8,
    pub active_weapon: String,
    pub is_alive: bool,
    pub is_ducking: bool,
    pub is_walking: bool,
    pub is_scoped: bool,
    pub flash_remaining: f32,
    pub place: String,
}

pub struct ParseResult {
    pub map_name: String,
    pub rows: Vec<PlayerTickRow>,
    pub warnings: Vec<String>,
}

const PLAYER_PROPS: &[&str] = &[
    "X",
    "Y",
    "Z",
    "yaw",
    "pitch",
    "velocity",
    "health",
    "armor_value",
    "active_weapon_name",
    "is_alive",
    "ducking",
    "is_walking",
    "is_scoped",
    "flash_duration",
    "last_place_name",
    "team_num",
];

const WANTED_EVENTS: &[&str] = &["round_start", "round_freeze_end", "begin_new_match"];

/// 64 Hz -> 16 Hz (§4.3 tick örnekleme stratejisi).
const TICK_SAMPLE_DIVISOR: i32 = 4;
const TICK_RATE: f32 = 64.0;

pub fn parse_demo_bytes(bytes: &[u8], match_id: Uuid) -> Result<ParseResult> {
    let huf = create_huffman_lookup_table();
    // Çekirdek parser gerçek prop adları ister ("health" -> "CCSPlayerPawn.m_iHealth");
    // çıktı kolonları real_name_to_og_name ile friendly ada geri bağlanır.
    let friendly: Vec<String> = PLAYER_PROPS.iter().map(|s| s.to_string()).collect();
    let real_names = rm_user_friendly_names(&friendly).map_err(|e| anyhow!("prop adı çevrilemedi: {e:?}"))?;
    let mut real_name_to_og_name = AHashMap::default();
    for (real, og) in real_names.iter().zip(&friendly) {
        real_name_to_og_name.insert(real.clone(), og.clone());
    }
    let inputs = ParserInputs {
        real_name_to_og_name,
        wanted_players: vec![],
        wanted_player_props: real_names,
        wanted_other_props: vec![],
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: vec![], // boş = tüm tick'ler
        wanted_events: WANTED_EVENTS.iter().map(|s| s.to_string()).collect(),
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: false,
        only_convars: false,
        huffman_lookup_table: &huf,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    };

    let mut demo_parser = Parser::new(inputs, ParsingMode::Normal);
    let output = demo_parser
        .parse_demo(bytes)
        .map_err(|e| anyhow!("demoparser: {e:?}"))?;

    let mut warnings = Vec::new();

    let map_name = output
        .header
        .as_ref()
        .and_then(|h| h.get("map_name").cloned())
        .unwrap_or_else(|| {
            warnings.push("header'da map_name yok".to_string());
            "unknown".to_string()
        });

    // Pass A: raunt sınırları. Isınma rauntlarını elemek için son
    // begin_new_match'ten sonraki round_start'lar sayılır.
    let match_start_tick = output
        .game_events
        .iter()
        .filter(|e| e.name == "begin_new_match")
        .map(|e| e.tick)
        .max()
        .unwrap_or(i32::MIN);

    let mut round_starts: Vec<i32> = output
        .game_events
        .iter()
        .filter(|e| e.name == "round_start" && e.tick >= match_start_tick)
        .map(|e| e.tick)
        .collect();
    round_starts.sort_unstable();
    round_starts.dedup();
    if round_starts.is_empty() {
        bail!("demoda round_start olayı bulunamadı");
    }

    let freeze_ends: Vec<i32> = {
        let mut v: Vec<i32> = output
            .game_events
            .iter()
            .filter(|e| e.name == "round_freeze_end")
            .map(|e| e.tick)
            .collect();
        v.sort_unstable();
        v
    };

    // Pass B kolonları: friendly name -> kolon
    let mut col_by_name: AHashMap<&str, &PropColumn> = AHashMap::default();
    for info in &output.prop_controller.prop_infos {
        if let Some(col) = output.df.get(&info.id) {
            col_by_name.insert(info.prop_friendly_name.as_str(), col);
        }
    }
    let col = |name: &str| -> Result<&VarVec> {
        col_by_name
            .get(name)
            .and_then(|c| c.data.as_ref())
            .ok_or_else(|| anyhow!("beklenen kolon çıktıda yok: {name}"))
    };

    let ticks = output
        .df
        .get(&TICK_ID)
        .and_then(|c| c.data.as_ref())
        .context("tick kolonu yok")?;
    let steamids = output
        .df
        .get(&STEAMID_ID)
        .and_then(|c| c.data.as_ref())
        .context("steamid kolonu yok")?;

    let n = varvec_len(ticks);
    let (c_x, c_y, c_z) = (col("X")?, col("Y")?, col("Z")?);
    let (c_yaw, c_pitch) = (col("yaw")?, col("pitch")?);
    let c_vel = col("velocity")?;
    let (c_hp, c_armor) = (col("health")?, col("armor_value")?);
    let c_weapon = col("active_weapon_name")?;
    let c_alive = col("is_alive")?;
    let c_duck = col("ducking")?;
    let c_walk = col("is_walking")?;
    let c_scope = col("is_scoped")?;
    let c_flash = col("flash_duration")?;
    let c_place = col("last_place_name")?;
    let c_team = col("team_num")?;

    let mut rows = Vec::with_capacity(n / TICK_SAMPLE_DIVISOR as usize + 1);
    for i in 0..n {
        let tick = match as_i64(ticks, i) {
            Some(t) => t as i32,
            None => continue,
        };
        if tick % TICK_SAMPLE_DIVISOR != 0 {
            continue; // 16 Hz örnekleme
        }
        // team_num: 2=T, 3=CT; diğerleri (spectator vb.) atlanır
        let side = match as_i64(c_team, i) {
            Some(2) => 1i8,
            Some(3) => 2i8,
            _ => continue,
        };
        // raunt ataması: kaçıncı round_start bu tick'ten önce?
        let round_idx = round_starts.partition_point(|&s| s <= tick);
        if round_idx == 0 {
            continue; // maç başlamadan önceki satırlar (ısınma)
        }
        let round_start = round_starts[round_idx - 1];
        let next_start = round_starts.get(round_idx).copied().unwrap_or(i32::MAX);
        // bu rauntun freeze_end'i: [round_start, next_start) içindeki ilk kayıt
        let fe = freeze_ends
            .iter()
            .find(|&&f| f >= round_start && f < next_start)
            .copied()
            .unwrap_or(round_start);
        let round_time = ((tick - fe) as f32 / TICK_RATE).max(0.0);

        let steamid = match as_u64(steamids, i) {
            Some(s) if s > 0 => s,
            _ => continue,
        };

        rows.push(PlayerTickRow {
            match_id,
            map_name: map_name.clone(),
            round_number: (round_idx).min(255) as u8,
            tick: tick as u32,
            round_time,
            // Faz 0: PG players tablosu yok; steamid64'ten deterministik UUIDv5
            player_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, steamid.to_string().as_bytes()),
            side,
            x: as_f32(c_x, i).unwrap_or(0.0),
            y: as_f32(c_y, i).unwrap_or(0.0),
            z: as_f32(c_z, i).unwrap_or(0.0),
            yaw: as_f32(c_yaw, i).unwrap_or(0.0),
            pitch: as_f32(c_pitch, i).unwrap_or(0.0),
            velocity: as_f32(c_vel, i).unwrap_or(0.0),
            health: as_i64(c_hp, i).unwrap_or(0).clamp(0, 255) as u8,
            armor: as_i64(c_armor, i).unwrap_or(0).clamp(0, 255) as u8,
            active_weapon: as_string(c_weapon, i).unwrap_or_default(),
            is_alive: as_bool(c_alive, i).unwrap_or(false),
            is_ducking: as_bool(c_duck, i).unwrap_or(false),
            is_walking: as_bool(c_walk, i).unwrap_or(false),
            is_scoped: as_bool(c_scope, i).unwrap_or(false),
            flash_remaining: as_f32(c_flash, i).unwrap_or(0.0),
            place: as_string(c_place, i).unwrap_or_default(),
        });
    }

    if rows.is_empty() {
        bail!("parse tamamlandı ama hiç player_ticks satırı üretilmedi");
    }

    Ok(ParseResult { map_name, rows, warnings })
}

fn varvec_len(v: &VarVec) -> usize {
    match v {
        VarVec::U32(x) => x.len(),
        VarVec::Bool(x) => x.len(),
        VarVec::U64(x) => x.len(),
        VarVec::F32(x) => x.len(),
        VarVec::I32(x) => x.len(),
        VarVec::String(x) => x.len(),
        _ => 0,
    }
}

fn as_f32(v: &VarVec, i: usize) -> Option<f32> {
    match v {
        VarVec::F32(x) => x.get(i).copied().flatten(),
        VarVec::I32(x) => x.get(i).copied().flatten().map(|n| n as f32),
        VarVec::U32(x) => x.get(i).copied().flatten().map(|n| n as f32),
        _ => None,
    }
}

fn as_i64(v: &VarVec, i: usize) -> Option<i64> {
    match v {
        VarVec::I32(x) => x.get(i).copied().flatten().map(|n| n as i64),
        VarVec::U32(x) => x.get(i).copied().flatten().map(|n| n as i64),
        VarVec::U64(x) => x.get(i).copied().flatten().map(|n| n as i64),
        VarVec::F32(x) => x.get(i).copied().flatten().map(|n| n as i64),
        _ => None,
    }
}

fn as_u64(v: &VarVec, i: usize) -> Option<u64> {
    match v {
        VarVec::U64(x) => x.get(i).copied().flatten(),
        VarVec::U32(x) => x.get(i).copied().flatten().map(|n| n as u64),
        VarVec::I32(x) => x.get(i).copied().flatten().and_then(|n| u64::try_from(n).ok()),
        _ => None,
    }
}

fn as_bool(v: &VarVec, i: usize) -> Option<bool> {
    match v {
        VarVec::Bool(x) => x.get(i).copied().flatten(),
        _ => as_i64(v, i).map(|n| n != 0),
    }
}

fn as_string(v: &VarVec, i: usize) -> Option<String> {
    match v {
        VarVec::String(x) => x.get(i).cloned().flatten(),
        _ => None,
    }
}

// Variant, game event alanları için kullanılabilir; şimdilik yalnızca tick gerekiyor.
#[allow(dead_code)]
fn variant_i64(v: &Variant) -> Option<i64> {
    match v {
        Variant::I32(n) => Some(*n as i64),
        Variant::U32(n) => Some(*n as i64),
        Variant::U64(n) => Some(*n as i64),
        _ => None,
    }
}
