// WASM Analyze çekirdeği: parser'ın ham çıktısını My DB'nin Bundle formatına
// (localdb.ts) çevirir. SAF fonksiyon — tarayıcıda (Web Worker) ve Node
// testinde aynı kod koşar; parser fonksiyonları dışarıdan enjekte edilir.
//
// v1 kapsamı (bilinçli): replay (pozisyon/yaw/HP/zırh/silah), kill feed,
// raunt çipleri (kazanan/sebep), granat izleri. SUNUCUDA OLUP BURADA
// OLMAYANLAR (null bırakılır, arayüz tolere eder): buy tipleri, strateji
// kümeleri, winprob, HUD kümülatif istatistikler, envanter, flash süresi,
// atış izleri, para. Bunlar v2 adayı.
import { MAP_CAL } from './mapcal';
import type {
  GrenadeMark, KillMark, KillRow, MatchDetail, MatchPlayerRow,
  PlayerTrack, RoundRow, RoundTicks,
} from '../../api';
import type { Bundle } from '../localdb';

// wasm paketinin imzaları (pkg-node ve pkg-web aynı)
export interface ParserApi {
  parseHeader(b: Uint8Array): unknown;
  parseEvent(b: Uint8Array, name: string, extraPlayer?: unknown, extraOther?: unknown): unknown[];
  parseEvents(b: Uint8Array, names: string[], extraPlayer?: unknown, extraOther?: unknown): unknown[];
  parseTicks(b: Uint8Array, props: string[], ticks?: number[] | null,
             players?: unknown, soa?: boolean): unknown[];
  parseGrenades(b: Uint8Array, extraProps?: string[], grenades?: boolean): unknown[];
}

// serde-wasm-bindgen satırları Map olarak döndürür; Node tarafında da öyle
type Row = Record<string, unknown>;
const row = (r: unknown): Row =>
  r instanceof Map ? (Object.fromEntries(r) as Row) : (r as Row);

const TICK_RATE = 64;
const GRID_STEP = 4; // 64 Hz / 4 = 16 Hz — sunucu replay'iyle aynı çözünürlük

export interface ShapeResult {
  bundle: Bundle;
  mapName: string;
  warnings: string[];
}

export function shapeDemo(api: ParserApi, bytes: Uint8Array, sourceName: string,
                          onPhase?: (s: string) => void): ShapeResult {
  const warnings: string[] = [];
  const phase = (s: string) => onPhase?.(s);
  phase('reading header');
  const header = row(api.parseHeader(bytes));
  const mapName = String(header.map_name ?? '');
  const cal = MAP_CAL[mapName];
  if (!cal) throw new Error(`map "${mapName}" has no radar calibration yet`);
  const toRx = (x: number) => (x - cal.pos_x) / cal.scale;
  const toRy = (y: number) => (cal.pos_y - y) / cal.scale;

  // ---- rauntlar --------------------------------------------------------
  phase('extracting rounds & kills');
  const evs = api.parseEvents(bytes, ['round_start', 'round_freeze_end', 'round_end'])
    .map(row)
    .sort((a, b) => Number(a.tick) - Number(b.tick));
  interface Span { n: number; start: number; freeze: number | null; end: number;
                   winner: 'T' | 'CT' | null; reason: string | null }
  const spans: Span[] = [];
  let cur: Partial<Span> | null = null;
  for (const e of evs) {
    const tick = Number(e.tick);
    if (e.event_name === 'round_start') {
      cur = { start: tick, freeze: null };
    } else if (e.event_name === 'round_freeze_end') {
      if (cur) cur.freeze = tick;
    } else if (e.event_name === 'round_end') {
      const rn = Number(e.round ?? 0);
      if (rn >= 1 && cur && cur.start !== undefined) {
        spans.push({
          n: rn, start: cur.start, freeze: cur.freeze ?? null, end: tick,
          winner: e.winner === 'T' || e.winner === 'CT' ? e.winner : null,
          reason: e.reason != null ? String(e.reason) : null,
        });
      }
      cur = null;
    }
  }
  if (!spans.length) throw new Error('no complete rounds found in this demo');

  // ---- tick ızgarası + oyuncu izleri -----------------------------------
  const grid: number[] = [];
  for (const s of spans) {
    for (let t = s.start; t <= s.end; t += GRID_STEP) grid.push(t);
  }
  phase('parsing player positions (the long part)');
  const props = ['X', 'Y', 'Z', 'yaw', 'pitch', 'health', 'armor',
                 'is_alive', 'active_weapon_name', 'team_num', 'team_clan_name',
                 'balance', 'inventory', 'has_helmet', 'flash_duration',
                 'current_equip_value', 'start_balance'];
  const tickRows = api.parseTicks(bytes, props, grid, null, false).map(row);

  // steamid → oyuncu; tick → (steamid → satır)
  interface P { nick: string; clanByRound: Map<number, string>;
                sideByRound: Map<number, 'T' | 'CT'> }
  const players = new Map<string, P>();
  const byTick = new Map<number, Map<string, Row>>();
  const roundOfTick = (t: number) => spans.find((s) => t >= s.start && t <= s.end);
  for (const r of tickRows) {
    const sid = String(r.steamid ?? '');
    if (!sid || sid === '0') continue;
    let p = players.get(sid);
    if (!p) { p = { nick: String(r.name ?? sid), clanByRound: new Map(), sideByRound: new Map() }; players.set(sid, p); }
    const t = Number(r.tick);
    const sp = roundOfTick(t);
    if (sp) {
      const side = Number(r.team_num) === 2 ? 'T' : Number(r.team_num) === 3 ? 'CT' : null;
      if (side) p.sideByRound.set(sp.n, side);
      if (r.team_clan_name) p.clanByRound.set(sp.n, String(r.team_clan_name));
    }
    let m = byTick.get(t);
    if (!m) { m = new Map(); byTick.set(t, m); }
    m.set(sid, r);
  }

  // ---- takımlar (klan adlarından; yoksa Team A/B) ----------------------
  const clanOfSide = (n: number, side: 'T' | 'CT'): string | null => {
    for (const p of players.values()) {
      if (p.sideByRound.get(n) === side) return p.clanByRound.get(n) ?? null;
    }
    return null;
  };
  const teamA = clanOfSide(1, 'CT') ?? 'Team A';
  const teamB = clanOfSide(1, 'T') ?? 'Team B';
  // pseudo id'ler: My DB skor hesabı (scoreOf) t/ct_team_id ister
  const idOfClan = (c: string | null) => (c === teamA ? 'A' : c === teamB ? 'B' : null);

  // ---- kill'ler ---------------------------------------------------------
  const killRows = api.parseEvent(bytes, 'player_death').map(row)
    .sort((a, b) => Number(a.tick) - Number(b.tick));
  const kills: KillRow[] = [];
  for (const k of killRows) {
    const t = Number(k.tick);
    const sp = roundOfTick(t);
    if (!sp) continue;
    kills.push({
      round_number: sp.n, tick: t,
      round_time: Math.max(0, (t - (sp.freeze ?? sp.start)) / TICK_RATE),
      attacker: k.attacker_name != null ? String(k.attacker_name) : null,
      victim: k.user_name != null ? String(k.user_name) : null,
      assister: k.assister_name != null ? String(k.assister_name) : null,
      weapon: k.weapon != null ? String(k.weapon) : null,
      headshot: k.headshot === true,
    });
  }

  // ---- granatlar --------------------------------------------------------
  // İki kaynak birleşir: (a) uçuş izleri — parseGrenades, entity_id ile
  // gruplu (atış noktası buradan); (b) patlama EVENT'leri — tip + konum +
  // atıcı buradan (bu pinli wasm binding'i granat tipini iz satırlarına
  // koymuyor, event adı tek güvenilir tip kaynağı).
  phase('tracing grenades');
  interface Trail { sid: string; firstTick: number; lastTick: number;
                    fx: number; fy: number; fz: number | null }
  const trailsByEnt = new Map<string, Trail>();
  for (const raw of api.parseGrenades(bytes, ['X', 'Y', 'Z', 'entity_id'], true)) {
    const r = row(raw);
    if (r.X == null || r.Y == null || r.entity_id == null) continue;
    const key = `${r.entity_id}|${r.steamid}`;
    const t = Number(r.tick);
    const tr = trailsByEnt.get(key);
    if (!tr) {
      trailsByEnt.set(key, { sid: String(r.steamid ?? ''), firstTick: t, lastTick: t,
        fx: Number(r.X), fy: Number(r.Y), fz: r.Z != null ? Number(r.Z) : null });
    } else {
      if (t < tr.firstTick) { tr.firstTick = t; tr.fx = Number(r.X); tr.fy = Number(r.Y); tr.fz = r.Z != null ? Number(r.Z) : null; }
      if (t > tr.lastTick) tr.lastTick = t;
    }
  }
  const trails = [...trailsByEnt.values()];

  const DET_EVENTS: Record<string, GrenadeMark['type']> = {
    smokegrenade_detonate: 'smoke', flashbang_detonate: 'flash',
    hegrenade_detonate: 'he', molotov_detonate: 'molotov',
    inferno_startburn: 'molotov', decoy_started: 'decoy',
  };
  interface Det { type: GrenadeMark['type']; tick: number; x: number; y: number;
                  z: number | null; thrower: string | null; sid: string }
  const dets: Det[] = [];
  for (const raw of api.parseEvents(bytes, Object.keys(DET_EVENTS))) {
    const e = row(raw);
    if (e.x == null || e.y == null) continue;
    const d: Det = {
      type: DET_EVENTS[String(e.event_name)], tick: Number(e.tick),
      x: Number(e.x), y: Number(e.y), z: e.z != null ? Number(e.z) : null,
      thrower: e.user_name != null ? String(e.user_name) : null,
      sid: String(e.user_steamid ?? ''),
    };
    // molotov_detonate + inferno_startburn aynı granat için ikiz düşebilir
    if (d.type === 'molotov' && dets.some((o) => o.type === 'molotov'
        && Math.abs(o.tick - d.tick) <= 32
        && Math.hypot(o.x - d.x, o.y - d.y) < 150)) continue;
    dets.push(d);
  }
  // patlamaya en yakın izi bul (aynı atıcı, iz patlamadan önce başlamış,
  // patlama izin bitişine yakın) → atış noktası
  const throwOf = (d: Det): Trail | null => {
    let best: Trail | null = null; let score = Infinity;
    for (const tr of trails) {
      if (tr.sid !== d.sid || tr.firstTick > d.tick) continue;
      const gap = Math.abs(d.tick - tr.lastTick);
      if (gap <= TICK_RATE * 3 && gap < score) { best = tr; score = gap; }
    }
    return best;
  };

  // ---- raunt başına RoundTicks ------------------------------------------
  phase('assembling replay');
  const rounds: Record<number, RoundTicks> = {};
  const roundRows: RoundRow[] = [];
  for (const s of spans) {
    const ticks: number[] = [];
    for (let t = s.start; t <= s.end; t += GRID_STEP) ticks.push(t);

    const tracks: PlayerTrack[] = [];
    for (const [sid, p] of players) {
      const side = p.sideByRound.get(s.n);
      if (!side) continue; // bu rauntta oynamadı (koç/izleyici)
      const N = ticks.length;
      const tr: PlayerTrack = {
        player_id: sid, nickname: p.nick, side,
        rx: new Array(N).fill(null), ry: new Array(N).fill(null),
        yaw: new Array(N).fill(null), hp: new Array(N).fill(null),
        armor: new Array(N).fill(null), alive: new Array(N).fill(null),
        weapon: new Array(N).fill(null), inv: new Array(N).fill(null),
        flash: new Array(N).fill(null), helmet: new Array(N).fill(null),
        lower: cal.has_lower ? new Array(N).fill(null) : undefined,
        shots: [], money: new Array(N).fill(null),
        wz: new Array(N).fill(null), pitch: new Array(N).fill(null),
        money_start: null, equip_value: null,
      };
      let seen = false;
      ticks.forEach((t, i) => {
        const r = byTick.get(t)?.get(sid);
        if (!r || r.X == null || r.Y == null) return;
        seen = true;
        tr.rx[i] = toRx(Number(r.X));
        tr.ry[i] = toRy(Number(r.Y));
        tr.yaw[i] = r.yaw != null ? Number(r.yaw) : null;
        tr.pitch[i] = r.pitch != null ? Number(r.pitch) : null;
        tr.hp[i] = r.health != null ? Number(r.health) : null;
        tr.armor[i] = r.armor != null ? Number(r.armor) : null;
        tr.alive[i] = r.is_alive != null ? r.is_alive === true : null;
        tr.weapon[i] = r.active_weapon_name != null ? String(r.active_weapon_name) : null;
        tr.money[i] = r.balance != null ? Number(r.balance) : null;
        tr.inv[i] = Array.isArray(r.inventory) ? (r.inventory as string[]) : null;
        tr.helmet[i] = r.has_helmet != null ? r.has_helmet === true : null;
        tr.flash[i] = r.flash_duration != null ? Number(r.flash_duration) : null;
        if (cal.has_lower && r.Z != null && cal.split_z != null) {
          tr.lower![i] = Number(r.Z) < cal.split_z;
        }
        if (tr.money_start == null && r.start_balance != null) {
          tr.money_start = Number(r.start_balance);
        }
        // ekipman değeri: freeze bitimindeki (satın alma sonrası) ilk örnek
        if (s.freeze != null && t >= s.freeze && tr.equip_value == null
            && r.current_equip_value != null) {
          tr.equip_value = Number(r.current_equip_value);
        }
      });
      if (seen) tracks.push(tr);
    }

    // kill işaretleri: kurbanın en yakın ızgara pozisyonu
    const marks: KillMark[] = [];
    for (const k of killRows) {
      const t = Number(k.tick);
      if (t < s.start || t > s.end) continue;
      const vict = String(k.user_steamid ?? '');
      const gi = Math.min(ticks.length - 1, Math.max(0, Math.floor((t - s.start) / GRID_STEP)));
      const vt = tracks.find((x) => x.player_id === vict);
      // geriye doğru ilk dolu örneği bul (ölüm anında iz kesilmiş olabilir)
      let rx: number | null = null, ry: number | null = null, lower: boolean | null = null;
      if (vt) {
        for (let i = gi; i >= 0; i--) {
          if (vt.rx[i] != null) { rx = vt.rx[i]; ry = vt.ry[i]; lower = vt.lower?.[i] ?? null; break; }
        }
      }
      marks.push({
        tick: t,
        attacker: k.attacker_name != null ? String(k.attacker_name) : null,
        victim: k.user_name != null ? String(k.user_name) : null,
        weapon: k.weapon != null ? String(k.weapon) : null,
        victim_rx: rx, victim_ry: ry, lower,
      });
    }

    // granat işaretleri (bu rauntta patlayanlar; atış noktası iz eşleşmesinden)
    const gmarks: GrenadeMark[] = [];
    for (const d of dets) {
      if (d.tick < s.start || d.tick > s.end) continue;
      const thrSide = players.get(d.sid)?.sideByRound.get(s.n) ?? null;
      const tr = throwOf(d);
      gmarks.push({
        type: d.type, tick: d.tick, side: thrSide, thrower: d.thrower,
        rx: toRx(d.x), ry: toRy(d.y),
        lower: cal.has_lower && d.z != null && cal.split_z != null
          ? d.z < cal.split_z : null,
        throw_tick: tr ? tr.firstTick : null,
        throw_rx: tr ? toRx(tr.fx) : null,
        throw_ry: tr ? toRy(tr.fy) : null,
        throw_lower: tr && cal.has_lower && tr.fz != null && cal.split_z != null
          ? tr.fz < cal.split_z : null,
      });
    }

    rounds[s.n] = {
      match_id: '', map_name: mapName, round_number: s.n,
      freeze_end_tick: s.freeze, tick_rate: TICK_RATE,
      radar: { pos_x: cal.pos_x, pos_y: cal.pos_y, scale: cal.scale,
               has_lower: cal.has_lower, split_z: cal.split_z },
      ticks, players: tracks, kills: marks, grenades: gmarks,
    };

    const tClan = clanOfSide(s.n, 'T');
    const ctClan = clanOfSide(s.n, 'CT');
    roundRows.push({
      round_number: s.n, start_tick: s.start, freeze_end_tick: s.freeze,
      end_tick: s.end, winner_side: s.winner, end_reason: s.reason,
      bomb_site: null, bomb_plant_tick: null,
      t_buy_type: null, ct_buy_type: null, t_cluster: null, ct_cluster: null,
      t_team_id: idOfClan(tClan), ct_team_id: idOfClan(ctClan),
    });
  }

  // ---- kimlik + detail ---------------------------------------------------
  // hızlı içerik parmak izi (FNV-1a, ilk 1MB + uzunluk) — lokal benzersizlik yeter
  let h = 2166136261;
  const lim = Math.min(bytes.length, 1 << 20);
  for (let i = 0; i < lim; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  const matchId = `wasm-${(h >>> 0).toString(16)}-${bytes.length.toString(16)}`;
  for (const rt of Object.values(rounds)) rt.match_id = matchId;

  const detail: MatchDetail = {
    match_id: matchId, map_name: mapName, status: 'ready',
    team_a_id: 'A', team_a: teamA, team_b_id: 'B', team_b: teamB,
    tournament: header.server_name != null ? String(header.server_name) : null,
    rounds: roundRows, kills,
  };
  const playerRows: MatchPlayerRow[] = [...players.entries()]
    .filter(([, p]) => p.sideByRound.size > 0)
    .map(([sid, p]) => ({
      player_id: sid, nickname: p.nick,
      t_rounds: [...p.sideByRound.entries()].filter(([, s2]) => s2 === 'T').map(([n]) => n),
      ct_rounds: [...p.sideByRound.entries()].filter(([, s2]) => s2 === 'CT').map(([n]) => n),
    }));

  return {
    bundle: { match_id: matchId, name: sourceName, detail, players: playerRows,
              rounds, origin: 'single' as const },
    mapName, warnings,
  };
}
