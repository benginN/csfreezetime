import type { RoundRow } from '../api';

/** Takım adından deterministik ton (monogram "logosu" için). */
export function teamHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Monogram harfleri: "Team Spirit" → "TS", "G2 Esports" → "G2". */
export function teamInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Which team won the round: 'A' | 'B' relative to match team_a_id. */
export function winnerTeamClass(r: RoundRow, teamAId: string | null): 'A' | 'B' | '' {
  if (!r.winner_side || !teamAId) return '';
  const wid = r.winner_side === 'T' ? r.t_team_id : r.ct_team_id;
  if (!wid) return '';
  return wid === teamAId ? 'A' : 'B';
}

/** True when sides swapped between the previous round and this one (halftime/OT). */
export function isSideSwap(prev: RoundRow | undefined, r: RoundRow): boolean {
  return !!prev && !!prev.t_team_id && !!r.t_team_id && prev.t_team_id !== r.t_team_id;
}

// Raunt şeridi ayraç indeksleri (i = bu chipten ÖNCE ayraç çiz). İki kaynak:
//  - taraf değişimi: null t_team_id'li raunt zinciri koparmasın diye son
//    BİLİNEN kimlikle karşılaştırılır (parçalı kayıtların boş rauntları)
//  - MR12 yapısal sınırlar: devre (13) + uzatma yarıları (25'ten itibaren
//    her 3 raunt) — CS2'de takımlar uzatmaya girerken taraf değiştirmez,
//    yani 25'te veri swap'ı yoktur ama görsel sınır beklenir.
// Parçalı kayıtta gerçek numara = round_number + roundOffset.
export function roundDividers(rounds: RoundRow[], roundOffset = 0): Set<number> {
  const out = new Set<number>();
  let last: string | null = null;
  rounds.forEach((r, i) => {
    if (i > 0) {
      const actual = r.round_number + roundOffset;
      if (actual === 13 || (actual > 24 && (actual - 25) % 3 === 0)) out.add(i);
      if (r.t_team_id && last && r.t_team_id !== last) out.add(i);
    }
    if (r.t_team_id) last = r.t_team_id;
  });
  return out;
}

export function chipTitle(
  r: RoundRow,
  teams: { aId: string | null; a: string | null; b: string | null },
  strat?: { t: Map<number, string>; ct: Map<number, string> },
): string {
  const cls = winnerTeamClass(r, teams.aId);
  const winner = cls === 'A' ? teams.a : cls === 'B' ? teams.b : null;
  const bits = [`r${r.round_number}`];
  if (winner) bits.push(`${winner} won (${r.winner_side})`);
  if (r.end_reason) bits.push(r.end_reason);
  if (r.bomb_site) bits.push(`bomb ${r.bomb_site}`);
  bits.push(`T:${r.t_buy_type ?? '?'} CT:${r.ct_buy_type ?? '?'}`);
  // strateji etiketleri (ML kümeleri — Analyze'da adlandırılır)
  if (strat) {
    const tl = r.t_cluster != null ? strat.t.get(r.t_cluster) : null;
    const cl = r.ct_cluster != null ? strat.ct.get(r.ct_cluster) : null;
    if (tl) bits.push(`T strat: ${tl}`);
    if (cl) bits.push(`CT setup: ${cl}`);
  }
  // thrown: kaybeden taraf kazanma olasılığında ≥%75 zirve yaptıysa
  if (r.winner_side && r.max_t_prob != null && r.max_ct_prob != null) {
    const loserPeak = r.winner_side === 'T' ? r.max_ct_prob : r.max_t_prob;
    if (loserPeak >= 0.75) bits.push(`⚠ thrown round — loser peaked at ${Math.round(100 * loserPeak)}% win chance`);
  }
  return bits.join(' · ');
}
