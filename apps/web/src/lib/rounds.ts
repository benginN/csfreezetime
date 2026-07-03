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
