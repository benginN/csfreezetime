// Lokal takım raporu: kullanıcının kendi (IndexedDB) arşivi üzerinde,
// sunucudaki rakip raporunun deterministik eşleniği — tamamı tarayıcıda.
// Sunucudan yalnız KAMUSAL modeller çekilir (harita yerleşimleri + global
// kazanma olasılığı tablosu); kullanıcı verisi dışarı çıkmaz.
// Strateji kümeleme/tahmin bilerek yok: düşük maç sayısında anlamsız (§10).
import { api, type RoundRow, type RoundTicks } from '../api';
import { getRound, listMatches, type LocalMatchMeta } from './localdb';

const TICK = 64;
const RADIUS: Record<string, number> = { smoke: 48, molotov: 48, flash: 72, he: 72 };

export interface LocalReport {
  team: string;
  map: string;
  matches: number;
  overview: {
    wins: number; t_rounds: number; t_wins: number;
    ct_rounds: number; ct_wins: number;
    pistol_n: number; pistol_w: number; conv_n: number; conv_w: number;
  };
  economy: { buy: Record<string, Record<string, number>>; afterPistolLoss: Record<string, number> };
  utility: {
    side: string; type: string; label: string; rx: number; ry: number;
    count: number; t_avg: number;
  }[];
  setups: { side: string; pattern: string; n: number; share: number }[];
  players: {
    nickname: string; side: string; rounds: number;
    entry_share: number; opening_k: number; opening_d: number;
    awp_share: number; util_pr: number; blind_kills: number;
  }[];
  trades: { trader: string; avenged: string; n: number }[];
  thrown: { match_id: string; round: number; peak: number }[];
  note: string;
}

function lb(a: number[], v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

export async function buildLocalReport(teamName: string, mapName: string): Promise<LocalReport> {
  const all = await listMatches();
  const mine = all.filter((m) =>
    m.detail.map_name === mapName &&
    (m.detail.team_a === teamName || m.detail.team_b === teamName));

  const layout = await api.mapLayout(mapName).catch(() => null);
  const places = layout?.places ?? [];
  const nearestPlace = (rx: number, ry: number): string => {
    let best = '?', bd = Infinity;
    for (const p of places) {
      const d = (p.rx - rx) ** 2 + (p.ry - ry) ** 2;
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  };
  const wp = await api.winprob().catch(() => null);
  const wpMap = new Map<string, number>();
  const wpParent = new Map<string, { w: number; n: number }>();
  for (const c of wp?.cells ?? []) {
    wpMap.set(`${c.alive_t},${c.alive_ct},${c.bomb ? 1 : 0},${c.tbucket}`, c.p);
    const pk = `${c.alive_t},${c.alive_ct},${c.bomb ? 1 : 0}`;
    const pa = wpParent.get(pk) ?? { w: 0, n: 0 };
    pa.w += c.p * c.n; pa.n += c.n;
    wpParent.set(pk, pa);
  }
  const tbucket = (sec: number, plantSec: number | null): number => {
    if (plantSec != null && sec >= plantSec) {
      const dt = sec - plantSec;
      return dt < 10 ? 4 : dt < 25 ? 5 : 6;
    }
    const rem = 115 - sec;
    return rem > 75 ? 0 : rem > 45 ? 1 : rem > 20 ? 2 : 3;
  };

  const ov = { wins: 0, t_rounds: 0, t_wins: 0, ct_rounds: 0, ct_wins: 0, pistol_n: 0, pistol_w: 0, conv_n: 0, conv_w: 0 };
  const buy: Record<string, Record<string, number>> = { T: {}, CT: {} };
  const afterPistolLoss: Record<string, number> = {};
  type Spot = { rx: number; ry: number; count: number; tSum: number };
  const spots = new Map<string, Spot[]>(); // side:type
  const setupCount = new Map<string, number>(); // side|pattern
  const setupTotal: Record<string, number> = { T: 0, CT: 0 };
  type PStat = { rounds: number; entry: number; ok: number; od: number; awp: number; util: number; blind: number };
  const pstats = new Map<string, PStat>(); // nickname|side
  const tradePairs = new Map<string, number>();
  const thrown: LocalReport['thrown'] = [];

  for (const m of mine) {
    const myId = m.detail.team_a === teamName ? m.detail.team_a_id : m.detail.team_b_id;
    let myScore = 0, theirScore = 0;

    for (const r of m.detail.rounds as RoundRow[]) {
      const mySide: 'T' | 'CT' = r.t_team_id === myId ? 'T' : 'CT';
      const won = r.winner_side === mySide;
      if (r.winner_side) {
        if (won) myScore++; else theirScore++;
        if (mySide === 'T') { ov.t_rounds++; if (won) ov.t_wins++; }
        else { ov.ct_rounds++; if (won) ov.ct_wins++; }
        if (r.round_number === 1 || r.round_number === 13) {
          ov.pistol_n++; if (won) ov.pistol_w++;
        }
      }
      const myBuy = mySide === 'T' ? r.t_buy_type : r.ct_buy_type;
      if (myBuy && r.round_number !== 1 && r.round_number !== 13) {
        buy[mySide][myBuy] = (buy[mySide][myBuy] ?? 0) + 1;
      }
      // pistol dönüşümü / kaybı
      if (r.round_number === 2 || r.round_number === 14) {
        const prev = (m.detail.rounds as RoundRow[]).find((x) => x.round_number === r.round_number - 1);
        if (prev?.winner_side) {
          const prevSide: 'T' | 'CT' = prev.t_team_id === myId ? 'T' : 'CT';
          const prevWon = prev.winner_side === prevSide;
          if (prevWon) { ov.conv_n++; if (won) ov.conv_w++; }
          else if (myBuy) afterPistolLoss[myBuy] = (afterPistolLoss[myBuy] ?? 0) + 1;
        }
      }

      const rt: RoundTicks | undefined = await getRound(m.match_id, r.round_number);
      if (!rt) continue;
      const fe = rt.freeze_end_tick ?? rt.ticks[0];
      const myTracks = rt.players.filter((p) => p.side === mySide);

      // --- utility noktaları (açgözlü yarıçap kümeleme, sunucuyla aynı) ---
      for (const g of rt.grenades) {
        if (g.side !== mySide || g.rx == null || g.ry == null) continue;
        const typ = g.type === 'incendiary' ? 'molotov' : g.type;
        if (typ === 'decoy') continue;
        const key = `${mySide}:${typ}`;
        const arr = spots.get(key) ?? [];
        if (!spots.has(key)) spots.set(key, arr);
        const R2 = (RADIUS[typ] ?? 60) ** 2;
        const tsec = g.throw_tick != null ? (g.throw_tick - fe) / TICK : 0;
        let hit = false;
        for (const sp of arr) {
          if ((sp.rx - g.rx) ** 2 + (sp.ry - g.ry) ** 2 < R2) {
            sp.rx = (sp.rx * sp.count + g.rx) / (sp.count + 1);
            sp.ry = (sp.ry * sp.count + g.ry) / (sp.count + 1);
            sp.count++; sp.tSum += tsec; hit = true; break;
          }
        }
        if (!hit) arr.push({ rx: g.rx, ry: g.ry, count: 1, tSum: tsec });
      }

      // --- kurulum deseni (fe+15 sn'deki yerleşimler) ---
      if (places.length) {
        const i15 = Math.min(lb(rt.ticks, fe + 15 * TICK), rt.ticks.length - 1);
        const ps: string[] = [];
        for (const p of myTracks) {
          const rx = p.rx[i15], ry = p.ry[i15];
          if (rx != null && ry != null && (p.alive[i15] ?? false)) ps.push(nearestPlace(rx, ry));
        }
        if (ps.length >= 4) {
          const cnt = new Map<string, number>();
          ps.forEach((x) => cnt.set(x, (cnt.get(x) ?? 0) + 1));
          const pat = [...cnt.entries()].sort().map(([k, v]) => `${k}×${v}`).join(' ');
          setupCount.set(`${mySide}|${pat}`, (setupCount.get(`${mySide}|${pat}`) ?? 0) + 1);
          setupTotal[mySide]++;
        }
      }

      // --- oyuncular: giriş düellosu, AWP, utility, kör kill ---
      const kills = [...rt.kills].sort((a, b) => a.tick - b.tick);
      const first = kills[0];
      const nickSide = new Map(rt.players.map((p) => [p.nickname, p.side]));
      for (const p of myTracks) {
        const key = `${p.nickname}|${mySide}`;
        const st = pstats.get(key) ?? { rounds: 0, entry: 0, ok: 0, od: 0, awp: 0, util: 0, blind: 0 };
        if (!pstats.has(key)) pstats.set(key, st);
        st.rounds++;
        if (first && (first.attacker === p.nickname || first.victim === p.nickname)) {
          st.entry++;
          if (first.attacker === p.nickname) st.ok++; else st.od++;
        }
        const iAwp = Math.min(lb(rt.ticks, fe + 15 * TICK), rt.ticks.length - 1);
        if ((p.inv[iAwp] ?? []).some((w) => w.toLowerCase().includes('awp'))) st.awp++;
        st.util += rt.grenades.filter((g) => g.thrower === p.nickname).length;
      }
      // kör kill: kurbanın flash değeri o an > 0.3 sn
      for (const k of kills) {
        if (!k.attacker || nickSide.get(k.attacker) !== mySide) continue;
        const vt = rt.players.find((p) => p.nickname === k.victim);
        if (!vt) continue;
        const ki = Math.min(lb(rt.ticks, k.tick), rt.ticks.length - 1);
        if ((vt.flash[ki] ?? 0) > 0.3) {
          const key = `${k.attacker}|${mySide}`;
          const st = pstats.get(key);
          if (st) st.blind++;
        }
      }
      // trade ikilileri (5 sn penceresi)
      for (const k2 of kills) {
        if (!k2.attacker || nickSide.get(k2.attacker) !== mySide) continue;
        for (const k1 of kills) {
          if (k1.tick > k2.tick || k2.tick - k1.tick > 320) continue;
          if (k1.attacker === k2.victim && k1.victim && nickSide.get(k1.victim) === mySide) {
            const key = `${k2.attacker}→${k1.victim}`;
            tradePairs.set(key, (tradePairs.get(key) ?? 0) + 1);
            break;
          }
        }
      }

      // --- atılan raunt (zirve ≥%75 iken kayıp) ---
      if (wpMap.size && r.winner_side && !won) {
        const plantSec = r.bomb_plant_tick != null ? (r.bomb_plant_tick - fe) / TICK : null;
        let peak = 0;
        for (let i = 0; i < rt.ticks.length; i += 16) { // saniyede bir örnek
          const sec = (rt.ticks[i] - fe) / TICK;
          if (sec < 0) continue;
          let at = 0, act = 0;
          for (const p of rt.players) {
            if (p.alive[i]) { if (p.side === 'T') at++; else act++; }
          }
          const bomb = plantSec != null && sec >= plantSec ? 1 : 0;
          const k = `${at},${act},${bomb},${tbucket(sec, plantSec)}`;
          let pT = wpMap.get(k);
          if (pT == null) {
            const pa = wpParent.get(`${at},${act},${bomb}`);
            pT = pa && pa.n > 0 ? pa.w / pa.n : 0.5;
          }
          const pMine = mySide === 'T' ? pT : 1 - pT;
          if (pMine > peak) peak = pMine;
        }
        if (peak >= 0.75) thrown.push({ match_id: m.match_id, round: r.round_number, peak });
      }
    }
    if (myScore > theirScore) ov.wins++;
  }

  const utility = [...spots.entries()].flatMap(([key, arr]) => {
    const [side, type] = key.split(':');
    return arr.filter((sp) => sp.count >= 3).map((sp) => ({
      side, type, label: nearestPlace(sp.rx, sp.ry),
      rx: sp.rx, ry: sp.ry, count: sp.count, t_avg: sp.tSum / sp.count,
    }));
  }).sort((a, b) => b.count - a.count);

  const setups = [...setupCount.entries()]
    .map(([k, n]) => {
      const [side, pattern] = k.split('|');
      return { side, pattern, n, share: n / Math.max(1, setupTotal[side]) };
    })
    .filter((s) => s.n >= 3)
    .sort((a, b) => b.share - a.share);

  const players = [...pstats.entries()].map(([k, st]) => {
    const [nickname, side] = k.split('|');
    return {
      nickname, side, rounds: st.rounds,
      entry_share: st.entry / Math.max(1, st.rounds),
      opening_k: st.ok, opening_d: st.od,
      awp_share: st.awp / Math.max(1, st.rounds),
      util_pr: st.util / Math.max(1, st.rounds),
      blind_kills: st.blind,
    };
  }).sort((a, b) => a.nickname.localeCompare(b.nickname));

  const trades = [...tradePairs.entries()]
    .map(([k, n]) => { const [trader, avenged] = k.split('→'); return { trader, avenged, n }; })
    .filter((t) => t.n >= 2)
    .sort((a, b) => b.n - a.n).slice(0, 10);

  return {
    team: teamName, map: mapName, matches: mine.length,
    overview: ov,
    economy: { buy, afterPistolLoss },
    utility, setups, players, trades,
    thrown: thrown.sort((a, b) => b.peak - a.peak).slice(0, 12),
    note: 'computed in your browser from your local archive; strategy clustering/prediction need a larger archive and stay server-class',
  };
}

export async function localTeams(): Promise<{ name: string; maps: string[]; matches: number }[]> {
  const all = await listMatches();
  const byTeam = new Map<string, { maps: Set<string>; matches: number }>();
  const add = (name: string | null, map: string | null, m: LocalMatchMeta) => {
    void m;
    if (!name) return;
    const e = byTeam.get(name) ?? { maps: new Set<string>(), matches: 0 };
    if (!byTeam.has(name)) byTeam.set(name, e);
    if (map) e.maps.add(map);
    e.matches++;
  };
  for (const m of all) {
    add(m.detail.team_a, m.detail.map_name, m);
    add(m.detail.team_b, m.detail.map_name, m);
  }
  return [...byTeam.entries()]
    .map(([name, e]) => ({ name, maps: [...e.maps].sort(), matches: e.matches }))
    .sort((a, b) => b.matches - a.matches);
}
