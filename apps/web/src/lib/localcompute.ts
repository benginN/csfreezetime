// Lokal maçlar için sunucu eşleniği hesaplar: heatmap ve ghost stack,
// IndexedDB'deki raunt verisinden üretilir — sunucuya istek gitmez.
// Hücre/hizalama semantiği sunucuyla birebir (cell=8 radar birimi;
// align: round_start | bomb_plant | first_kill).
import type { MatchHeatmap, RoundTicks, StackLayer, StackResp } from '../api';
import { getMatch, getRound } from './localdb';

const CELL = 8;

export async function localHeatmap(
  matchId: string, p: URLSearchParams,
): Promise<MatchHeatmap> {
  const side = p.get('side') ?? '';
  const playerId = p.get('player_id') ?? '';
  const roundList = (p.get('rounds') ?? '').split(',').filter(Boolean).map(Number);
  const upper = new Map<string, number>();
  const lower = new Map<string, number>();
  let radar: MatchHeatmap['radar'] | null = null;
  let count = 0;

  for (const n of roundList) {
    const r = await getRound(matchId, n);
    if (!r) continue;
    radar = r.radar;
    count++;
    for (const pl of r.players) {
      if (side && pl.side !== side) continue;
      if (playerId && pl.player_id !== playerId) continue;
      for (let i = 0; i < pl.rx.length; i++) {
        const rx = pl.rx[i], ry = pl.ry[i];
        if (rx == null || ry == null || !(pl.alive[i] ?? false)) continue;
        const key = `${Math.floor(rx / CELL)}:${Math.floor(ry / CELL)}`;
        const m = (pl.lower?.[i] ?? false) ? lower : upper;
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
  }
  const toCells = (m: Map<string, number>): [number, number, number][] =>
    [...m.entries()].map(([k, w]) => {
      const [cx, cy] = k.split(':').map(Number);
      return [cx, cy, w];
    });
  return {
    cells: toCells(upper),
    cells_lower: lower.size ? toCells(lower) : undefined,
    cell_radar: CELL,
    round_count: count,
    radar: radar!,
  };
}

export async function localStack(
  matchId: string,
  rounds: number[],
  align: string,
  side?: string,
): Promise<StackResp> {
  const meta = await getMatch(matchId);
  const layers: StackLayer[] = [];
  let mapName = '';
  let radar: StackResp['radar'] | null = null;

  for (const n of rounds) {
    const r = await getRound(matchId, n);
    if (!r) continue;
    mapName = r.map_name;
    radar = r.radar;
    const rMeta = meta?.detail.rounds.find((x) => x.round_number === n);

    let alignTick: number | null = r.freeze_end_tick;
    let skipped = '';
    if (align === 'bomb_plant') {
      alignTick = rMeta?.bomb_plant_tick ?? null;
      if (alignTick == null) skipped = 'no bomb plant';
    } else if (align === 'first_kill') {
      alignTick = r.kills.length ? Math.min(...r.kills.map((k) => k.tick)) : null;
      if (alignTick == null) skipped = 'no kills';
    } else if (alignTick == null) {
      skipped = 'no freeze end';
    }

    const ly: StackLayer = {
      match_id: matchId, round_number: n,
      align_tick: alignTick ?? 0,
      ...(skipped ? { skipped } : {}),
      players: [],
    };
    if (!skipped && alignTick != null) {
      for (const pl of r.players) {
        if (side && pl.side !== side) continue;
        const t: number[] = [], rx: number[] = [], ry: number[] = [];
        const lo: boolean[] = [], hp: number[] = [], armor: number[] = [];
        const money: number[] = [];
        const invT: number[] = [], invV: string[] = [];
        for (let i = 0; i < pl.rx.length; i++) {
          const x = pl.rx[i], y = pl.ry[i];
          if (x == null || y == null || !(pl.alive[i] ?? false)) continue;
          const ts = (r.ticks[i] - alignTick) / (r.tick_rate || 64);
          t.push(ts); rx.push(x); ry.push(y);
          lo.push(pl.lower?.[i] ?? false);
          hp.push(pl.hp[i] ?? 0);
          armor.push(pl.armor[i] ?? 0);
          money.push(pl.money[i] ?? 0);
          const inv = (pl.inv[i] ?? []).join(', ');
          if (!invV.length || invV[invV.length - 1] !== inv) {
            invT.push(ts); invV.push(inv);
          }
        }
        ly.players!.push({
          side: pl.side, nick: pl.nickname, t, rx, ry,
          lower: lo, hp, armor, money, inv_t: invT, inv_v: invV,
        });
      }
    }
    layers.push(ly);
  }
  return { map_name: mapName, radar: radar!, align, layers };
}
