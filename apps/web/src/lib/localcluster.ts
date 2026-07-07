// Strateji kümeleme — sunucudaki ml/features.py + clustering.py'nin
// tarayıcı portu, kullanıcının lokal arşivi üzerinde. Aynı öznitelikler
// (ilk 30 sn: 6×5 sn pencere bölge doluluğu + utility sayıları), aynı
// algoritma (k-means, tohum 42, n_init 10, silhouette ile k seçimi),
// aynı dürüstlük kapıları (MIN_ROUNDS altında hiç sonuç dönmez).
// Fark: bölge adları CH 'place' kolonu yerine kamusal harita yerleşim
// merkezlerine en-yakın atamayla bulunur (yaklaşıklama, etikette söylenir).
import { api, type RoundRow } from '../api';
import { getRound, listMatches } from './localdb';

const WINDOWS = 6;
const WINDOW_SEC = 5;
const MAX_PLACES = 16;
const UTIL_TYPES = ['smoke', 'flash', 'molotov', 'he'];
const MIN_ROUNDS = 12;
const TICK = 64;

export interface LocalTendency {
  cluster_id: number;
  label: string;           // otomatik: en belirgin bölgeler
  observed: number;
  sample_size: number;
  prob: number;
}
export interface LocalClusterResult {
  side: 'T' | 'CT';
  rounds: number;
  k: number;
  tendencies: LocalTendency[];
  conditional: { buy: string; cluster_id: number; label: string; prob: number; n: number }[];
}

// deterministik RNG (mulberry32)
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (a: Float64Array, b: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
};

function kmeansOnce(X: Float64Array[], k: number, seed: number) {
  const r = rng(seed);
  // kmeans++ başlatma
  const centers: Float64Array[] = [X[Math.floor(r() * X.length)].slice() as Float64Array];
  while (centers.length < k) {
    const d = X.map((x) => Math.min(...centers.map((c) => dist2(x, c))));
    const sum = d.reduce((a, b) => a + b, 0) || 1;
    let pick = r() * sum;
    let idx = 0;
    for (; idx < d.length - 1 && pick > d[idx]; idx++) pick -= d[idx];
    centers.push(X[idx].slice() as Float64Array);
  }
  const labels = new Int32Array(X.length);
  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    for (let i = 0; i < X.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(X[i], centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    const sums = centers.map(() => new Float64Array(X[0].length));
    const cnt = new Int32Array(k);
    for (let i = 0; i < X.length; i++) {
      cnt[labels[i]]++;
      const s = sums[labels[i]];
      for (let j = 0; j < s.length; j++) s[j] += X[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] === 0) continue;
      for (let j = 0; j < sums[c].length; j++) centers[c][j] = sums[c][j] / cnt[c];
    }
    if (!changed) break;
  }
  let inertia = 0;
  for (let i = 0; i < X.length; i++) inertia += dist2(X[i], centers[labels[i]]);
  return { labels, centers, inertia };
}

function kmeans(X: Float64Array[], k: number) {
  let best = kmeansOnce(X, k, 42);
  for (let i = 1; i < 10; i++) {
    const cand = kmeansOnce(X, k, 42 + i);
    if (cand.inertia < best.inertia) best = cand;
  }
  return best;
}

function silhouette(X: Float64Array[], labels: Int32Array, k: number): number {
  // O(n²) — lokal arşiv boyutunda (≤ birkaç yüz raunt) sorunsuz
  const n = X.length;
  let total = 0, counted = 0;
  for (let i = 0; i < n; i++) {
    const dSum = new Float64Array(k);
    const dCnt = new Int32Array(k);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.sqrt(dist2(X[i], X[j]));
      dSum[labels[j]] += d; dCnt[labels[j]]++;
    }
    const own = labels[i];
    if (dCnt[own] === 0) continue;
    const a = dSum[own] / dCnt[own];
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || dCnt[c] === 0) continue;
      b = Math.min(b, dSum[c] / dCnt[c]);
    }
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
    counted++;
  }
  return counted ? total / counted : -1;
}

export async function localClusters(
  teamName: string, mapName: string, side: 'T' | 'CT',
): Promise<LocalClusterResult | null> {
  const all = (await listMatches()).filter((m) => m.detail.map_name === mapName);
  const layout = await api.mapLayout(mapName).catch(() => null);
  const placesAll = layout?.places ?? [];
  if (placesAll.length < 4 || !all.length) return null;
  const nearest = (rx: number, ry: number): string => {
    let best = '', bd = Infinity;
    for (const p of placesAll) {
      const d = (p.rx - rx) ** 2 + (p.ry - ry) ** 2;
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  };

  // 1. geçiş: bölge frekansı → en yoğun 16 bölge (kolon uzayı, sunucu gibi)
  const freq = new Map<string, number>();
  type RoundRec = {
    key: string; mine: boolean; buy: string | null; cluster?: number;
    occ: Float64Array; util: Float64Array;
  };
  const recs: RoundRec[] = [];

  for (const m of all) {
    const myId = m.detail.team_a === teamName ? m.detail.team_a_id
      : m.detail.team_b === teamName ? m.detail.team_b_id : null;
    for (const r of m.detail.rounds as RoundRow[]) {
      const rt = await getRound(m.match_id, r.round_number);
      if (!rt) continue;
      const fe = rt.freeze_end_tick ?? rt.ticks[0];
      const iEnd = rt.ticks.findIndex((t) => t >= fe + WINDOWS * WINDOW_SEC * TICK);
      const end = iEnd < 0 ? rt.ticks.length : iEnd;
      const occCnt = new Map<string, number>(); // `${win}:${place}`
      const winTotal = new Float64Array(WINDOWS);
      for (const p of rt.players) {
        if (p.side !== side) continue;
        for (let i = 0; i < end; i++) {
          const rx = p.rx[i], ry = p.ry[i];
          const rtime = (rt.ticks[i] - fe) / TICK;
          if (rtime < 0 || rx == null || ry == null || !(p.alive[i] ?? false)) continue;
          const w = Math.floor(rtime / WINDOW_SEC);
          if (w >= WINDOWS) break;
          const pl = nearest(rx, ry);
          freq.set(pl, (freq.get(pl) ?? 0) + 1);
          occCnt.set(`${w}:${pl}`, (occCnt.get(`${w}:${pl}`) ?? 0) + 1);
          winTotal[w]++;
        }
      }
      if (![...occCnt.values()].length) continue;
      const util = new Float64Array(UTIL_TYPES.length);
      for (const g of rt.grenades) {
        if (g.side !== side) continue;
        const typ = g.type === 'incendiary' ? 'molotov' : g.type;
        const ui = UTIL_TYPES.indexOf(typ);
        if (ui < 0) continue;
        if (g.tick - fe < WINDOWS * WINDOW_SEC * TICK) util[ui] = Math.min(util[ui] + 1, 5);
      }
      for (let u = 0; u < util.length; u++) util[u] /= 5;
      const sideTeam = side === 'T' ? r.t_team_id : r.ct_team_id;
      const buy = side === 'T' ? r.t_buy_type : r.ct_buy_type;
      recs.push({
        key: `${m.match_id}:${r.round_number}`,
        mine: myId != null && sideTeam === myId,
        buy,
        occ: new Float64Array(0), // 2. geçişte doldurulur
        util,
      });
      // geçici sakla
      (recs[recs.length - 1] as RoundRec & { _cnt?: Map<string, number>; _tot?: Float64Array })._cnt = occCnt;
      (recs[recs.length - 1] as RoundRec & { _tot?: Float64Array })._tot = winTotal;
    }
  }
  if (recs.length < MIN_ROUNDS) return null;

  const places = [...freq.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PLACES).map(([p]) => p);
  const pIdx = new Map(places.map((p, i) => [p, i]));
  const P = places.length;

  const X: Float64Array[] = recs.map((rec) => {
    const r2 = rec as RoundRec & { _cnt?: Map<string, number>; _tot?: Float64Array };
    const v = new Float64Array(WINDOWS * P + UTIL_TYPES.length);
    for (const [k2, c] of r2._cnt!) {
      const [w, pl] = [Number(k2.split(':')[0]), k2.split(':').slice(1).join(':')];
      const pi = pIdx.get(pl);
      const tot = r2._tot![w] || 1;
      if (pi != null) v[w * P + pi] += c / tot;
    }
    v.set(rec.util, WINDOWS * P);
    return v;
  });

  // k seçimi (sunucuyla aynı kural)
  const n = X.length;
  let k = 3;
  if (n >= 30) {
    let bestS = -1;
    for (let kk = 3; kk <= Math.min(8, Math.floor(n / 8)); kk++) {
      const km = kmeans(X, kk);
      const s = silhouette(X, km.labels, kk);
      if (s > bestS) { bestS = s; k = kk; }
    }
  }
  const km = kmeans(X, k);

  // küme etiketi: merkezin pencere-ortalama bölge profili → ilk 3 bölge
  const labelOf = (c: number): string => {
    const center = km.centers[c];
    const avg = new Float64Array(P);
    for (let w = 0; w < WINDOWS; w++) {
      for (let p = 0; p < P; p++) avg[p] += center[w * P + p] / WINDOWS;
    }
    return [...avg.keys()].sort((a, b) => avg[b] - avg[a]).slice(0, 3)
      .filter((i) => avg[i] > 0.02).map((i) => places[i]).join(' + ') || `cluster ${c}`;
  };

  // eğilimler: benim rauntlarım vs lokal lig payı (büzülme k=20)
  const leagueCnt = new Float64Array(k);
  const mineCnt = new Float64Array(k);
  let mineN = 0;
  recs.forEach((rec, i) => {
    rec.cluster = km.labels[i];
    leagueCnt[km.labels[i]]++;
    if (rec.mine) { mineCnt[km.labels[i]]++; mineN++; }
  });
  if (mineN < MIN_ROUNDS) return null;
  const tendencies: LocalTendency[] = [...Array(k).keys()].map((c) => ({
    cluster_id: c,
    label: labelOf(c),
    observed: mineCnt[c],
    sample_size: mineN,
    prob: (mineCnt[c] + 20 * (leagueCnt[c] / n)) / (mineN + 20),
  })).sort((a, b) => b.prob - a.prob);

  // buy-koşullu (k=10), buy başına en olası küme
  const byBuy = new Map<string, Float64Array>();
  const buyN = new Map<string, number>();
  for (const rec of recs) {
    if (!rec.mine || !rec.buy) continue;
    const arr = byBuy.get(rec.buy) ?? new Float64Array(k);
    if (!byBuy.has(rec.buy)) byBuy.set(rec.buy, arr);
    arr[rec.cluster!]++;
    buyN.set(rec.buy, (buyN.get(rec.buy) ?? 0) + 1);
  }
  const conditional: LocalClusterResult['conditional'] = [];
  for (const [buy, arr] of byBuy) {
    const nb = buyN.get(buy)!;
    let bestC = 0, bestP = -1;
    for (let c = 0; c < k; c++) {
      const p = (arr[c] + 10 * (leagueCnt[c] / n)) / (nb + 10);
      if (p > bestP) { bestP = p; bestC = c; }
    }
    conditional.push({ buy, cluster_id: bestC, label: labelOf(bestC), prob: bestP, n: nb });
  }
  conditional.sort((a, b) => b.n - a.n);

  return { side, rounds: mineN, k, tendencies, conditional };
}
