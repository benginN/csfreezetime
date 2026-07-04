import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useRoster, useWindow, WindowPicker } from '../lib/window';
import { api } from '../api';
import { teamHue, teamInitials } from '../lib/rounds';

// Takım anasayfası: genel karne + harita karneleri (rapora link) + geçmiş maçlar.
export default function Team() {
  const { teamId = '' } = useParams();
  const [win, since, setWin] = useWindow();
  const [roster, setRoster] = useRoster();

  const summary = useQuery({
    queryKey: ['teamSummary', teamId, since, roster],
    queryFn: () => api.teamSummary(teamId, since, roster),
  });
  const matches = useQuery({
    queryKey: ['teamMatches', teamId, since, roster],
    queryFn: () => api.matches(teamId, since, roster),
  });

  if (summary.isLoading || !summary.data) return <p className="meta">loading…</p>;
  const d = summary.data;
  const ov = d.overview;

  return (
    <>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="monogram lg" style={{ background: `hsl(${teamHue(d.team)},45%,32%)` }}>
          {teamInitials(d.team)}
        </span>
        {d.team}
        <Link to={`/report/${teamId}`} style={{ fontSize: 13, fontWeight: 400 }}>
          Full opponent report →
        </Link>
        <Link to={`/compare?a=${teamId}`} style={{ fontSize: 13, fontWeight: 400 }}>
          ⚔ Compare with…
        </Link>
      </h1>
      <div className="toolbar noprint"><WindowPicker win={win} onChange={setWin} roster={roster} onRoster={setRoster} /></div>

      <div className="grid cards statgrid">
        <Stat label="Record" v={`${ov.wins}–${ov.matches - ov.wins}`} n={`${ov.matches} matches`} />
        <Stat label="T round win" v={pct(ov.t_wins, ov.t_rounds)} n={`${ov.t_wins}/${ov.t_rounds}`} />
        <Stat label="CT round win" v={pct(ov.ct_wins, ov.ct_rounds)} n={`${ov.ct_wins}/${ov.ct_rounds}`} />
        <Stat label="Pistol rounds" v={pct(ov.pistol_wins, ov.pistol_rounds)} n={`${ov.pistol_wins}/${ov.pistol_rounds}`} />
      </div>

      <h2>Maps</h2>
      <div className="grid cards">
        {d.maps.map((m) => (
          <Link key={m.map_name} to={`/report/${teamId}?map=${m.map_name}`} className="card">
            <div className="teams">
              <span>{m.map_name}</span>
              <span className="score">{m.wins}–{m.matches - m.wins}</span>
            </div>
            <div className="meta">
              round win {pct(m.round_wins, m.rounds)} ({m.round_wins}/{m.rounds}) · report →
            </div>
          </Link>
        ))}
      </div>

      <h2>Matches <span className="meta">({(matches.data ?? []).length}{since ? ` since ${since}` : ''}{roster > 0 ? ` · lineup ≥${roster}/5` : ''})</span></h2>
      {(matches.data ?? []).map((m) => (
        <Link key={m.match_id} to={`/match/${m.match_id}`} className="matchrow">
          <span className="vs">
            <span>{m.team_a}</span>
            <span className="score">{m.score_a} : {m.score_b}</span>
            <span>{m.team_b}</span>
          </span>
          <span className="badge gray">{m.map_name}</span>
          {m.tournament && <span className="meta cut" style={{ maxWidth: 200 }}>🏆 {m.tournament.replace(/-/g, ' ')}</span>}
          <span className="meta">{m.played_at ?? ''}</span>
        </Link>
      ))}
    </>
  );
}

function pct(a: number, b: number): string {
  return b ? `${Math.round((100 * a) / b)}%` : '—';
}

function Stat({ label, v, n }: { label: string; v: string; n: string }) {
  return (
    <div className="card">
      <div className="meta">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#b6e2b6' }}>{v}</div>
      <div className="meta">{n}</div>
    </div>
  );
}
