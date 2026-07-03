import type { RoundRow } from '../api';

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

export function chipTitle(
  r: RoundRow,
  teams: { aId: string | null; a: string | null; b: string | null },
): string {
  const cls = winnerTeamClass(r, teams.aId);
  const winner = cls === 'A' ? teams.a : cls === 'B' ? teams.b : null;
  const bits = [`r${r.round_number}`];
  if (winner) bits.push(`${winner} won (${r.winner_side})`);
  if (r.end_reason) bits.push(r.end_reason);
  if (r.bomb_site) bits.push(`bomb ${r.bomb_site}`);
  bits.push(`T:${r.t_buy_type ?? '?'} CT:${r.ct_buy_type ?? '?'}`);
  return bits.join(' · ');
}
