//! .dem baytları -> player_ticks satırları (mimari.md §4.3 Pass A + Pass B).

use ahash::AHashMap;
use anyhow::{anyhow, bail, Context, Result};
use parser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use parser::first_pass::prop_controller::{STEAMID_ID, TICK_ID};
use parser::parse_demo::{Parser, ParsingMode};
use parser::second_pass::game_events::GameEvent;
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
    pub inventory: Vec<String>,
}

pub struct ParseResult {
    pub map_name: String,
    pub rows: Vec<PlayerTickRow>,
    pub rounds: Vec<RoundMeta>,
    pub kills: Vec<KillMeta>,
    pub grenades: Vec<GrenadeMeta>,
    pub players: Vec<PlayerMeta>,
    pub player_rounds: Vec<PlayerRoundMeta>,
    pub warnings: Vec<String>,
}

// PostgreSQL meta veri satırları (mimari.md §5.2) ────────────────────

#[derive(Debug)]
pub struct RoundMeta {
    pub round_number: i16,
    pub start_tick: i32,
    pub freeze_end_tick: i32,
    pub end_tick: Option<i32>,
    pub winner_side: Option<String>,
    pub end_reason: Option<String>,
    pub bomb_plant_tick: Option<i32>,
    pub bomb_site: Option<String>,
    pub t_equip_value: Option<i32>,
    pub ct_equip_value: Option<i32>,
    pub t_team_name: Option<String>,
    pub ct_team_name: Option<String>,
}

#[derive(Debug)]
pub struct KillMeta {
    pub round_number: i16,
    pub tick: i32,
    pub round_time: f32,
    pub attacker_steamid: Option<u64>,
    pub victim_steamid: Option<u64>,
    pub assister_steamid: Option<u64>,
    pub weapon: Option<String>,
    pub headshot: bool,
    pub wallbang: bool,
    pub noscope: bool,
    pub through_smoke: bool,
    pub attacker_blind: bool,
    pub victim_blind: bool,
    pub attacker_pos: [Option<f32>; 3],
    pub victim_pos: [Option<f32>; 3],
    pub attacker_place: Option<String>,
    pub victim_place: Option<String>,
}

#[derive(Debug)]
pub struct GrenadeMeta {
    pub round_number: i16,
    pub thrower_steamid: Option<u64>,
    pub side: Option<String>,
    pub grenade_type: &'static str,
    pub detonate_tick: i32,
    pub det_pos: [Option<f32>; 3],
    pub throw_tick: Option<i32>,
    pub throw_pos: [Option<f32>; 3],
}

#[derive(Debug)]
pub struct PlayerMeta {
    pub steamid: u64,
    pub name: String,
    pub team_name: Option<String>,
}

#[derive(Debug, Default)]
pub struct PlayerRoundMeta {
    pub round_number: i16,
    pub steamid: u64,
    pub side: String,
    pub money_start: Option<i32>,
    pub money_spent: Option<i32>,
    pub equip_value: Option<i32>,
    pub survived: bool,
    pub kills: i16,
    pub deaths: i16,
    pub assists: i16,
    pub damage_dealt: i16,
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
    "inventory",
];

const WANTED_EVENTS: &[&str] = &[
    "round_start",
    "round_freeze_end",
    "round_end",
    "begin_new_match",
    "player_death",
    "player_hurt",
    "bomb_planted",
    "bomb_defused",
    "bomb_exploded",
    "flashbang_detonate",
    "smokegrenade_detonate",
    "hegrenade_detonate",
    "inferno_startburn",
    "decoy_started",
    "weapon_fire", // bomba atış anı + atanın konumu (uçuş animasyonu)
];

/// Ekonomi mini-pass'inde istenen prop'lar (round_start + freeze_end tick'lerinde).
const ECONOMY_PROPS: &[&str] = &[
    "balance",
    "cash_spent_this_round",
    "current_equip_value",
    "team_num",
    "team_clan_name",
];

/// 64 Hz -> 16 Hz (§4.3 tick örnekleme stratejisi).
const TICK_SAMPLE_DIVISOR: i32 = 4;
const TICK_RATE: f32 = 64.0;

/// Faz 1: PG players tablosuyla ve CH satırlarıyla tutarlı, steamid64'ten
/// deterministik oyuncu kimliği.
pub fn player_uuid(steamid: u64) -> Uuid {
    Uuid::new_v5(&Uuid::NAMESPACE_OID, steamid.to_string().as_bytes())
}

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
    let c_inv = col("inventory").ok(); // eski demolar/prop eksikliği tolere edilir

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
            player_id: player_uuid(steamid),
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
            inventory: as_string_vec(c_inv, i),
        });
    }

    if rows.is_empty() {
        bail!("parse tamamlandı ama hiç player_ticks satırı üretilmedi");
    }

    // ── PG meta verisi (mimari.md §4.3 adım 7) ──────────────────────
    let assign_round = |tick: i32| -> Option<usize> {
        let idx = round_starts.partition_point(|&s| s <= tick);
        (idx > 0).then_some(idx) // round_number = idx (1 tabanlı)
    };
    let freeze_for = |round_idx: usize| -> i32 {
        let start = round_starts[round_idx - 1];
        let next = round_starts.get(round_idx).copied().unwrap_or(i32::MAX);
        freeze_ends
            .iter()
            .find(|&&f| f >= start && f < next)
            .copied()
            .unwrap_or(start)
    };

    // Ekonomi mini-pass'i: yalnızca round_start + freeze_end tick'lerinde
    let econ_ticks: Vec<i32> = round_starts
        .iter()
        .copied()
        .chain((1..=round_starts.len()).map(&freeze_for))
        .collect();
    let econ = economy_pass(bytes, &huf, &econ_ticks).unwrap_or_else(|e| {
        warnings.push(format!("ekonomi pass'i başarısız: {e}"));
        AHashMap::default()
    });

    // Rauntlar
    let mut rounds_meta: Vec<RoundMeta> = (1..=round_starts.len())
        .map(|idx| {
            let fe = freeze_for(idx);
            let (t_eq, ct_eq) = econ_team_equip(&econ, fe);
            let (t_name, ct_name) = econ_team_names(&econ, fe);
            RoundMeta {
                round_number: idx as i16,
                start_tick: round_starts[idx - 1],
                freeze_end_tick: fe,
                end_tick: None,
                winner_side: None,
                end_reason: None,
                bomb_plant_tick: None,
                bomb_site: None,
                t_equip_value: t_eq,
                ct_equip_value: ct_eq,
                t_team_name: t_name,
                ct_team_name: ct_name,
            }
        })
        .collect();

    for ev in &output.game_events {
        let Some(idx) = assign_round(ev.tick) else { continue };
        let r = &mut rounds_meta[idx - 1];
        match ev.name.as_str() {
            "round_end" => {
                // Sentetik event: winner "T"/"CT", reason ROUND_WIN_REASON adı
                // (demoparser maps.rs) olarak String gelir.
                r.end_tick = Some(ev.tick);
                r.winner_side = ev_str(ev, "winner").filter(|w| w == "T" || w == "CT");
                r.end_reason = ev_str(ev, "reason").map(|c| {
                    match c.as_str() {
                        "bomb_exploded" => "bomb_exploded",
                        "bomb_defused" => "bomb_defused",
                        "t_killed" | "ct_killed" => "elimination",
                        "time_ran_out" | "t_saved" => "time",
                        _ => "other",
                    }
                    .to_string()
                });
            }
            "bomb_planted" => {
                r.bomb_plant_tick = Some(ev.tick);
                r.bomb_site = ev_str(ev, "user_last_place_name").and_then(|p| {
                    if p.contains('A') {
                        Some("A".to_string())
                    } else if p.contains('B') {
                        Some("B".to_string())
                    } else {
                        None
                    }
                });
            }
            _ => {}
        }
    }

    // Kill'ler + PRS agregasyonları
    let mut kills_meta = Vec::new();
    let mut kd: AHashMap<(usize, u64), (i16, i16, i16, i16)> = AHashMap::default(); // k,d,a,dmg
    for ev in output.game_events.iter().filter(|e| e.name == "player_death") {
        let Some(idx) = assign_round(ev.tick) else { continue };
        let fe = freeze_for(idx);
        let attacker = ev_u64(ev, "attacker_steamid");
        let victim = ev_u64(ev, "user_steamid");
        if let Some(a) = attacker {
            // team-kill'ler kill sayılmaz ama satır olarak tutulur
            if ev_i64(ev, "attacker_team_num") != ev_i64(ev, "user_team_num") {
                kd.entry((idx, a)).or_default().0 += 1;
            }
        }
        if let Some(v) = victim {
            kd.entry((idx, v)).or_default().1 += 1;
        }
        if let Some(ast) = ev_u64(ev, "assister_steamid") {
            kd.entry((idx, ast)).or_default().2 += 1;
        }
        kills_meta.push(KillMeta {
            round_number: idx as i16,
            tick: ev.tick,
            round_time: ((ev.tick - fe) as f32 / TICK_RATE).max(0.0),
            attacker_steamid: attacker,
            victim_steamid: victim,
            assister_steamid: ev_u64(ev, "assister_steamid"),
            weapon: ev_str(ev, "weapon"),
            headshot: ev_bool(ev, "headshot"),
            wallbang: ev_i64(ev, "penetrated").unwrap_or(0) > 0,
            noscope: ev_bool(ev, "noscope"),
            through_smoke: ev_bool(ev, "thrusmoke"),
            attacker_blind: ev_bool(ev, "attackerblind"),
            victim_blind: ev_f32(ev, "user_flash_duration").unwrap_or(0.0) > 0.0,
            attacker_pos: [ev_f32(ev, "attacker_X"), ev_f32(ev, "attacker_Y"), ev_f32(ev, "attacker_Z")],
            victim_pos: [ev_f32(ev, "user_X"), ev_f32(ev, "user_Y"), ev_f32(ev, "user_Z")],
            attacker_place: ev_str(ev, "attacker_last_place_name"),
            victim_place: ev_str(ev, "user_last_place_name"),
        });
    }
    for ev in output.game_events.iter().filter(|e| e.name == "player_hurt") {
        let Some(idx) = assign_round(ev.tick) else { continue };
        // yalnızca düşmana verilen hasar sayılır
        if let (Some(a), Some(at), Some(vt)) = (
            ev_u64(ev, "attacker_steamid"),
            ev_i64(ev, "attacker_team_num"),
            ev_i64(ev, "user_team_num"),
        ) {
            if at != vt {
                kd.entry((idx, a)).or_default().3 +=
                    ev_i64(ev, "dmg_health").unwrap_or(0).clamp(0, 500) as i16;
            }
        }
    }

    // Bomba atışları: weapon_fire olayından (oyuncu, tip) → [(tick, konum)]
    // Patlama, kendinden önceki en yakın atışla eşleştirilir (≤ 15 sn pencere).
    let mut throws: AHashMap<(u64, &'static str), Vec<(i32, [Option<f32>; 3])>> =
        AHashMap::default();
    for ev in &output.game_events {
        if ev.name != "weapon_fire" {
            continue;
        }
        let nade = match ev_str(ev, "weapon").as_deref() {
            Some("weapon_smokegrenade") => "smoke",
            Some("weapon_flashbang") => "flash",
            Some("weapon_hegrenade") => "he",
            Some("weapon_molotov") | Some("weapon_incgrenade") => "molotov",
            Some("weapon_decoy") => "decoy",
            _ => continue,
        };
        let Some(sid) = ev_u64(ev, "user_steamid") else { continue };
        throws.entry((sid, nade)).or_default().push((
            ev.tick,
            [ev_f32(ev, "user_X"), ev_f32(ev, "user_Y"), ev_f32(ev, "user_Z")],
        ));
    }

    // Grenade'ler
    let mut grenades_meta = Vec::new();
    for ev in &output.game_events {
        let grenade_type = match ev.name.as_str() {
            "flashbang_detonate" => "flash",
            "smokegrenade_detonate" => "smoke",
            "hegrenade_detonate" => "he",
            "inferno_startburn" => "molotov", // molotov/incendiary ayrımı Faz 2
            "decoy_started" => "decoy",
            _ => continue,
        };
        let Some(idx) = assign_round(ev.tick) else { continue };
        let thrower = ev_u64(ev, "user_steamid");
        let (throw_tick, throw_pos) = thrower
            .and_then(|sid| throws.get(&(sid, grenade_type)))
            .and_then(|list| {
                list.iter()
                    .filter(|(t, _)| *t <= ev.tick && ev.tick - *t <= 15 * 64)
                    .max_by_key(|(t, _)| *t)
            })
            .map(|(t, p)| (Some(*t), *p))
            .unwrap_or((None, [None, None, None]));
        grenades_meta.push(GrenadeMeta {
            round_number: idx as i16,
            thrower_steamid: thrower,
            side: ev_i64(ev, "user_team_num").and_then(|t| match t {
                2 => Some("T".to_string()),
                3 => Some("CT".to_string()),
                _ => None,
            }),
            grenade_type,
            detonate_tick: ev.tick,
            det_pos: [ev_f32(ev, "x"), ev_f32(ev, "y"), ev_f32(ev, "z")],
            throw_tick,
            throw_pos,
        });
    }

    // Oyuncu → güncel takım adı: en son freeze anındaki clan name
    let mut player_team: AHashMap<u64, (i32, String)> = AHashMap::default();
    for (&(tick, sid), e) in econ.iter() {
        if let Some(tn) = &e.team_name {
            let entry = player_team.entry(sid).or_insert((tick, tn.clone()));
            if tick >= entry.0 {
                *entry = (tick, tn.clone());
            }
        }
    }

    // Oyuncular (roster; boşsa player_md)
    let roster = if output.roster.is_empty() { &output.player_md } else { &output.roster };
    let mut players_meta: Vec<PlayerMeta> = Vec::new();
    let mut seen = ahash::AHashSet::default();
    for p in roster {
        if let (Some(sid), Some(name)) = (p.steamid, p.name.clone()) {
            if sid > 0 && seen.insert(sid) {
                players_meta.push(PlayerMeta {
                    steamid: sid,
                    name,
                    team_name: player_team.get(&sid).map(|(_, t)| t.clone()),
                });
            }
        }
    }

    // player_round_states: freeze_end anındaki ekonomi + kill/death agregasyonu
    let mut deaths_in_round: AHashMap<usize, ahash::AHashSet<u64>> = AHashMap::default();
    for k in &kills_meta {
        if let Some(v) = k.victim_steamid {
            deaths_in_round.entry(k.round_number as usize).or_default().insert(v);
        }
    }
    let mut player_rounds = Vec::new();
    for idx in 1..=round_starts.len() {
        let start = round_starts[idx - 1];
        let fe = freeze_for(idx);
        for (&(tick, sid), e) in econ.iter() {
            if tick != fe {
                continue;
            }
            let side = match e.team {
                Some(2) => "T",
                Some(3) => "CT",
                _ => continue,
            };
            let money_start = econ.get(&(start, sid)).and_then(|s| s.balance);
            let (k, d, a, dmg) = kd.get(&(idx, sid)).copied().unwrap_or_default();
            player_rounds.push(PlayerRoundMeta {
                round_number: idx as i16,
                steamid: sid,
                side: side.to_string(),
                money_start,
                money_spent: e.spent,
                equip_value: e.equip,
                survived: !deaths_in_round.get(&idx).is_some_and(|s| s.contains(&sid)),
                kills: k,
                deaths: d,
                assists: a,
                damage_dealt: dmg,
            });
        }
    }

    Ok(ParseResult {
        map_name,
        rows,
        rounds: rounds_meta,
        kills: kills_meta,
        grenades: grenades_meta,
        players: players_meta,
        player_rounds,
        warnings,
    })
}

/// Freeze-end anında taraf → çoğunluk clan adı (side-swap güvenli: her raunt
/// kendi anlık eşlemesini taşır).
fn econ_team_names(
    econ: &AHashMap<(i32, u64), EconSnapshot>,
    freeze_tick: i32,
) -> (Option<String>, Option<String>) {
    let mut t_votes: AHashMap<&str, u32> = AHashMap::default();
    let mut ct_votes: AHashMap<&str, u32> = AHashMap::default();
    for (&(tick, _), e) in econ.iter() {
        if tick != freeze_tick {
            continue;
        }
        if let (Some(team), Some(name)) = (e.team, e.team_name.as_deref()) {
            match team {
                2 => *t_votes.entry(name).or_default() += 1,
                3 => *ct_votes.entry(name).or_default() += 1,
                _ => {}
            }
        }
    }
    let top = |v: AHashMap<&str, u32>| {
        v.into_iter().max_by_key(|(_, c)| *c).map(|(n, _)| n.to_string())
    };
    (top(t_votes), top(ct_votes))
}

/// Freeze-end anında taraf toplam ekipman değeri.
fn econ_team_equip(econ: &AHashMap<(i32, u64), EconSnapshot>, freeze_tick: i32) -> (Option<i32>, Option<i32>) {
    let (mut t, mut ct, mut any_t, mut any_ct) = (0i32, 0i32, false, false);
    for (&(tick, _), e) in econ.iter() {
        if tick != freeze_tick {
            continue;
        }
        match (e.team, e.equip) {
            (Some(2), Some(v)) => { t += v; any_t = true; }
            (Some(3), Some(v)) => { ct += v; any_ct = true; }
            _ => {}
        }
    }
    (any_t.then_some(t), any_ct.then_some(ct))
}

#[derive(Debug, Default, Clone)]
struct EconSnapshot {
    balance: Option<i32>,
    spent: Option<i32>,
    equip: Option<i32>,
    team: Option<i64>,
    team_name: Option<String>,
}

/// İkinci, ucuz parse: yalnızca verilen tick'lerde ekonomi prop'ları.
fn economy_pass(
    bytes: &[u8],
    huf: &Vec<(u8, u8)>,
    wanted_ticks: &[i32],
) -> Result<AHashMap<(i32, u64), EconSnapshot>> {
    let friendly: Vec<String> = ECONOMY_PROPS.iter().map(|s| s.to_string()).collect();
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
        wanted_ticks: wanted_ticks.to_vec(),
        wanted_events: vec![],
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: false,
        only_convars: false,
        huffman_lookup_table: huf,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    };
    let mut p = Parser::new(inputs, ParsingMode::Normal);
    let out = p.parse_demo(bytes).map_err(|e| anyhow!("ekonomi parse: {e:?}"))?;

    let mut col_by_name: AHashMap<&str, &PropColumn> = AHashMap::default();
    for info in &out.prop_controller.prop_infos {
        if let Some(col) = out.df.get(&info.id) {
            col_by_name.insert(info.prop_friendly_name.as_str(), col);
        }
    }
    let col = |name: &str| -> Option<&VarVec> { col_by_name.get(name).and_then(|c| c.data.as_ref()) };
    let (ticks, sids) = match (
        out.df.get(&TICK_ID).and_then(|c| c.data.as_ref()),
        out.df.get(&STEAMID_ID).and_then(|c| c.data.as_ref()),
    ) {
        (Some(t), Some(s)) => (t, s),
        _ => bail!("ekonomi pass çıktısında tick/steamid kolonu yok"),
    };
    let (c_bal, c_spent, c_eq, c_team, c_tname) = (
        col("balance"),
        col("cash_spent_this_round"),
        col("current_equip_value"),
        col("team_num"),
        col("team_clan_name"),
    );

    let mut map = AHashMap::default();
    for i in 0..varvec_len(ticks) {
        let (Some(tick), Some(sid)) = (as_i64(ticks, i), as_u64(sids, i)) else { continue };
        if sid == 0 {
            continue;
        }
        map.insert(
            (tick as i32, sid),
            EconSnapshot {
                balance: c_bal.and_then(|c| as_i64(c, i)).map(|v| v as i32),
                spent: c_spent.and_then(|c| as_i64(c, i)).map(|v| v as i32),
                equip: c_eq.and_then(|c| as_i64(c, i)).map(|v| v as i32),
                team: c_team.and_then(|c| as_i64(c, i)),
                team_name: c_tname.and_then(|c| as_string(c, i)).filter(|s| !s.is_empty()),
            },
        );
    }
    Ok(map)
}

// Game event alan okuyucuları ─────────────────────────────────────────

fn ev_field<'a>(ev: &'a GameEvent, name: &str) -> Option<&'a Variant> {
    ev.fields.iter().find(|f| f.name == name).and_then(|f| f.data.as_ref())
}

fn ev_u64(ev: &GameEvent, name: &str) -> Option<u64> {
    match ev_field(ev, name)? {
        Variant::U64(n) => Some(*n),
        Variant::U32(n) => Some(*n as u64),
        Variant::I32(n) => u64::try_from(*n).ok(),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|&n| n > 0)
}

fn ev_i64(ev: &GameEvent, name: &str) -> Option<i64> {
    match ev_field(ev, name)? {
        Variant::I32(n) => Some(*n as i64),
        Variant::U32(n) => Some(*n as i64),
        Variant::U64(n) => Some(*n as i64),
        Variant::Bool(b) => Some(*b as i64),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn ev_f32(ev: &GameEvent, name: &str) -> Option<f32> {
    match ev_field(ev, name)? {
        Variant::F32(n) => Some(*n),
        Variant::I32(n) => Some(*n as f32),
        Variant::U32(n) => Some(*n as f32),
        _ => None,
    }
}

fn ev_bool(ev: &GameEvent, name: &str) -> bool {
    matches!(ev_field(ev, name), Some(Variant::Bool(true)))
        || matches!(ev_field(ev, name), Some(Variant::I32(n)) if *n != 0)
}

fn ev_str(ev: &GameEvent, name: &str) -> Option<String> {
    match ev_field(ev, name)? {
        Variant::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
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

fn as_string_vec(v: Option<&VarVec>, i: usize) -> Vec<String> {
    match v {
        Some(VarVec::StringVec(x)) => x.get(i).cloned().unwrap_or_default(),
        _ => Vec::new(),
    }
}
