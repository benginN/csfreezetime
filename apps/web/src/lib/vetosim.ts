// Veto simülasyonunun TS portu (statik site) — services/stats-svc/veto.go
// ile AYNI mantık ve sabitler; girdi olarak sitede zaten yayınlanan takım
// özetlerinin (teams/{id}/summary) maps satırlarını kullanır.
// Kaynak formül: güç = (round_wins + k·0.5) / (rounds + k), k=20.

const K = 20.0;

export interface VetoMapRow { map_name: string; round_wins: number; rounds: number }
export interface VetoStep { action: string; map: string; edge: number; n: number }
export interface VetoResult {
  format: string;
  pool: number;
  pool_maps: { map: string; prob_a: number; n: number }[];
  steps: VetoStep[];
  finals: { map: string; prob_a: number; edge: number; n: number }[];
  note: string;
}

export function vetoSim(aMaps: VetoMapRow[], bMaps: VetoMapRow[], format: string): VetoResult {
  const sA = new Map(aMaps.map((m) => [m.map_name, (m.round_wins + K * 0.5) / (m.rounds + K)]));
  const sB = new Map(bMaps.map((m) => [m.map_name, (m.round_wins + K * 0.5) / (m.rounds + K)]));
  const nA = new Map(aMaps.map((m) => [m.map_name, m.rounds]));
  const nB = new Map(bMaps.map((m) => [m.map_name, m.rounds]));

  interface P { name: string; total: number; sA: number; sB: number }
  const seen = new Set([...sA.keys(), ...sB.keys()]);
  let pool: P[] = [...seen].map((m) => ({
    name: m, total: (nA.get(m) ?? 0) + (nB.get(m) ?? 0),
    sA: sA.get(m) ?? 0.5, sB: sB.get(m) ?? 0.5,
  }));
  pool.sort((x, y) => y.total - x.total);
  if (pool.length > 7) pool = pool.slice(0, 7);
  if (pool.length < 3) throw new Error('not enough shared map data for a veto simulation');

  const order = format === 'bo1'
    ? ['banA', 'banB', 'banA', 'banB', 'banA', 'banB', 'decider']
    : format === 'bo5'
      ? ['banA', 'banB', 'pickA', 'pickB', 'pickA', 'pickB', 'decider']
      : ['banA', 'banB', 'pickA', 'pickB', 'banA', 'banB', 'decider'];

  const edge = (p: P) => p.sA - p.sB;
  const remaining = [...pool];
  const take = (score: (p: P) => number): P => {
    let bi = 0;
    remaining.forEach((p, i) => { if (score(p) > score(remaining[bi])) bi = i; });
    return remaining.splice(bi, 1)[0];
  };

  const steps: VetoStep[] = [];
  const picks: VetoStep[] = [];
  for (const o of order) {
    if (!remaining.length) break;
    let p: P;
    if (o === 'banA') p = take((x) => -edge(x));
    else if (o === 'banB') p = take(edge);
    else if (o === 'pickA') p = take(edge);
    else if (o === 'pickB') p = take((x) => -edge(x));
    else { p = remaining[0]; remaining.length = 0; }
    const st = { action: o, map: p.name, edge: edge(p), n: (nA.get(p.name) ?? 0) + (nB.get(p.name) ?? 0) };
    steps.push(st);
    if (o === 'pickA' || o === 'pickB' || o === 'decider') picks.push(st);
  }

  const clamp = (e: number) => Math.min(0.85, Math.max(0.15, 0.5 + e * 3));
  return {
    format, pool: pool.length,
    pool_maps: pool
      .map((p) => ({ map: p.name, prob_a: clamp(edge(p)), n: (nA.get(p.name) ?? 0) + (nB.get(p.name) ?? 0) }))
      .sort((x, y) => y.prob_a - x.prob_a),
    steps,
    finals: picks.map((p) => ({ map: p.map, prob_a: clamp(p.edge), edge: p.edge, n: p.n })),
    note: 'strengths are shrunk round-win rates (k=20); map win prob is a linear heuristic on the edge, clamped to 15-85%',
  };
}
