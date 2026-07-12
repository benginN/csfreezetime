// Moments-lite: statik sitede DSL alt kümesi. Sunucudaki dsl/compile.go'nun
// kill/grenade/bomb/economy dallarını, exporter'ın harita-başına yayınladığı
// kompakt indeks (services/stats-svc/momentslite.go) üzerinde koşar.
// presence CH tick verisi ister — stüdyoda kalır. Sözlük sıraları (buy,
// side, grenade tipi) sunucu tarafıyla BİREBİR sözleşmedir.
import type { QueryResult, Clip } from '../api';
import { staticGet } from './staticdata';

const TICK_RATE = 64;
const BUYS = ['', 'pistol', 'eco', 'semi', 'force', 'full'];
const GRENS = ['', 'flash', 'smoke', 'he', 'molotov', 'incendiary', 'decoy'];
const SIDES = ['', 'T', 'CT'];

interface MomentsIndex {
  v: number;
  map: string;
  matches: { id: string; src: string }[];
  weapons: string[];
  places: string[];
  players: string[];
  end_reasons: string[];
  rounds: {
    m: number[]; n: number[]; tb: number[]; cb: number[]; te: number[];
    ce: number[]; fe: number[]; bs: number[]; bp: number[]; er: number[]; et: number[];
  };
  kills: {
    ri: number[]; t: number[]; rt: number[]; w: number[]; f: number[];
    ap: number[]; vp: number[]; a: number[]; s: number[];
  };
  grenades: { ri: number[]; t: number[]; g: number[]; s: number[]; f: number[]; p: number[] };
}

// DSL Query (dsl.go ile aynı şekil; yalnız kullanılan alanlar)
export interface LiteQuery {
  intent: string;
  filters: {
    map?: string;
    side?: string;
    buy_type?: string[];
    round_number?: { min?: number; max?: number };
    source?: string;
    player?: { nickname?: string };
    event?: {
      type: string;
      weapon?: string; first_kill?: boolean; trade?: boolean; headshot?: boolean;
      area?: string; area_of?: string;
      grenade_type?: string; order?: string;
      bomb_action?: string; site?: string;
      equip_min?: number; equip_max?: number;
      time_window?: { from: number; to: number };
    };
  };
  output?: { format?: string; context_seconds?: number[]; metric?: string };
}

const cache = new Map<string, Promise<MomentsIndex>>();
function getIndex(map: string): Promise<MomentsIndex> {
  let p = cache.get(map);
  if (!p) {
    p = staticGet<MomentsIndex>(`/api/v1/export/moments-index?map=${encodeURIComponent(map)}`);
    p.catch(() => cache.delete(map));
    cache.set(map, p);
  }
  return p;
}

interface Moment { ri: number; tick: number; rt: number }

// roundFilter karşılığı: filtreyi geçen rounds satır indeks kümesi
function roundSet(idx: MomentsIndex, f: LiteQuery['filters']): Set<number> {
  const r = idx.rounds;
  const out = new Set<number>();
  const buyIdx = (f.buy_type ?? []).map((b) => BUYS.indexOf(b));
  for (let i = 0; i < r.m.length; i++) {
    if (f.source && idx.matches[r.m[i]].src !== f.source) continue;
    const rn = f.round_number;
    if (rn?.min && r.n[i] < rn.min) continue;
    if (rn?.max && r.n[i] > rn.max) continue;
    if (buyIdx.length) {
      const ok =
        f.side === 'T' ? buyIdx.includes(r.tb[i]) :
        f.side === 'CT' ? buyIdx.includes(r.cb[i]) :
        buyIdx.includes(r.tb[i]) || buyIdx.includes(r.cb[i]);
      if (!ok) continue;
    }
    out.add(i);
  }
  return out;
}

function momentsFor(idx: MomentsIndex, q: LiteQuery, rounds: Set<number>): Moment[] {
  const ev = q.filters.event!;
  const f = q.filters;
  const out: Moment[] = [];
  const r = idx.rounds;

  if (ev.type === 'kill') {
    const k = idx.kills;
    const wantSide = SIDES.indexOf(f.side ?? '') > 0 ? SIDES.indexOf(f.side!) : 0;
    const wantW = ev.weapon ? idx.weapons.indexOf(ev.weapon.toLowerCase()) + 1 : 0;
    if (ev.weapon && wantW === 0) return []; // silah arşivde hiç yok
    const wantArea = ev.area ? idx.places.indexOf(ev.area) + 1 : 0;
    if (ev.area && wantArea === 0) return [];
    const wantA = f.player?.nickname
      ? idx.players.findIndex((p) => p.toLowerCase() === f.player!.nickname!.toLowerCase()) + 1
      : 0;
    if (f.player?.nickname && wantA === 0) return [];
    for (let i = 0; i < k.ri.length; i++) {
      if (!rounds.has(k.ri[i])) continue;
      if (wantSide && k.s[i] !== wantSide) continue;
      if (wantW && k.w[i] !== wantW) continue;
      if (ev.first_kill != null && !!(k.f[i] & 1) !== ev.first_kill) continue;
      if (ev.trade != null && !!(k.f[i] & 2) !== ev.trade) continue;
      if (ev.headshot != null && !!(k.f[i] & 4) !== ev.headshot) continue;
      if (wantArea && (ev.area_of === 'attacker' ? k.ap[i] : k.vp[i]) !== wantArea) continue;
      const tw = ev.time_window;
      if (tw && (k.rt[i] < tw.from || k.rt[i] > tw.to)) continue;
      if (wantA && k.a[i] !== wantA) continue;
      out.push({ ri: k.ri[i], tick: k.t[i], rt: k.rt[i] });
    }
    return out;
  }

  if (ev.type === 'grenade') {
    const g = idx.grenades;
    const wantSide = SIDES.indexOf(f.side ?? '') > 0 ? SIDES.indexOf(f.side!) : 0;
    const wantG = ev.grenade_type ? GRENS.indexOf(ev.grenade_type) : 0;
    const wantP = f.player?.nickname
      ? idx.players.findIndex((p) => p.toLowerCase() === f.player!.nickname!.toLowerCase()) + 1
      : 0;
    if (f.player?.nickname && wantP === 0) return [];
    for (let i = 0; i < g.ri.length; i++) {
      if (!rounds.has(g.ri[i])) continue;
      if (wantSide && g.s[i] !== wantSide) continue;
      if (wantG && g.g[i] !== wantG) continue;
      if (ev.order === 'first_of_type_in_round' && !(g.f[i] & 1)) continue;
      const rt = (g.t[i] - r.fe[g.ri[i]]) / TICK_RATE;
      const tw = ev.time_window;
      if (tw && (rt < tw.from || rt > tw.to)) continue;
      if (wantP && g.p[i] !== wantP) continue;
      out.push({ ri: g.ri[i], tick: g.t[i], rt: Math.max(rt, 0) });
    }
    return out;
  }

  if (ev.type === 'bomb') {
    const wantSite = ev.site === 'A' ? 1 : ev.site === 'B' ? 2 : 0;
    const act = ev.bomb_action || 'plant';
    const wantER = act === 'defuse' ? idx.end_reasons.indexOf('bomb_defused') + 1
      : act === 'explode' ? idx.end_reasons.indexOf('bomb_exploded') + 1 : 0;
    if (act !== 'plant' && wantER === 0) return [];
    for (const i of rounds) {
      if (wantSite && r.bs[i] !== wantSite) continue;
      let tick: number;
      if (act === 'plant') {
        if (!r.bp[i]) continue;
        tick = r.bp[i];
      } else {
        if (r.er[i] !== wantER) continue;
        tick = r.et[i];
      }
      const rt = Math.max((tick - r.fe[i]) / TICK_RATE, 0);
      const tw = ev.time_window;
      if (tw && (rt < tw.from || rt > tw.to)) continue;
      out.push({ ri: i, tick, rt });
    }
    out.sort((a, b) => a.ri - b.ri);
    return out;
  }

  if (ev.type === 'economy') {
    for (const i of rounds) {
      const v = f.side === 'CT' ? r.ce[i] : r.te[i];
      if (v < 0) continue; // SQL NULL: sunucuda eşik karşılaştırması geçmez
      if (ev.equip_min != null && v < ev.equip_min) continue;
      if (ev.equip_max != null && v > ev.equip_max) continue;
      out.push({ ri: i, tick: r.fe[i], rt: 0 });
    }
    out.sort((a, b) => a.ri - b.ri);
    return out;
  }

  throw new Error(
    'presence queries need ClickHouse tick data — run the self-hosted studio for this one',
  );
}

export async function liteQuery(raw: unknown): Promise<QueryResult> {
  const q = raw as LiteQuery;
  const start = performance.now();
  const f = q.filters ?? {};
  if (!f.map) {
    throw new Error('pick a map first — on the static site the archive is indexed per map');
  }
  if (f.event?.type === 'presence') {
    throw new Error(
      'presence queries need ClickHouse tick data — run the self-hosted studio for this one',
    );
  }
  const idx = await getIndex(f.map);
  const rounds = roundSet(idx, f);
  const res: QueryResult = { intent: q.intent, duration_ms: 0 };

  if (q.intent === 'heatmap_filterset' || !f.event) {
    res.round_count = rounds.size;
    if (q.intent === 'aggregate') res.count = rounds.size;
    res.duration_ms = Math.round(performance.now() - start);
    return res;
  }

  const moments = momentsFor(idx, q, rounds);
  res.round_count = rounds.size;
  const fmt = q.output?.format ?? (q.intent === 'aggregate' ? 'aggregate' : 'clips');
  const r = idx.rounds;

  if (fmt === 'clips') {
    const cs = q.output?.context_seconds ?? [5, 8];
    const pre = Math.round(cs[0] * TICK_RATE);
    const post = Math.round(cs[1] * TICK_RATE);
    res.clips = moments.map((m): Clip => ({
      match_id: idx.matches[r.m[m.ri]].id,
      map_name: idx.map,
      round_number: r.n[m.ri],
      tick: m.tick,
      round_time: m.rt,
      tick_start: Math.max(0, m.tick - pre),
      tick_end: m.tick + post,
    }));
  } else if (fmt === 'rounds') {
    const seen = new Set<number>();
    res.rounds = [];
    for (const m of moments) {
      if (seen.has(m.ri)) continue;
      seen.add(m.ri);
      res.rounds.push({
        match_id: idx.matches[r.m[m.ri]].id,
        map_name: idx.map,
        round_number: r.n[m.ri],
      });
    }
  } else {
    res.count = moments.length;
    if ((q.output?.metric ?? 'count') === 'per_round' && rounds.size > 0) {
      res.per_round = moments.length / rounds.size;
    }
  }
  res.duration_ms = Math.round(performance.now() - start);
  return res;
}
