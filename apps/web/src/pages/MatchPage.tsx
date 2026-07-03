import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { winnerTeamClass } from '../lib/rounds';
import ReplayView from '../components/ReplayView';

// Maç sayfası: kompakt başlık + sekmeler. Çipler kazanan TAKIM renginde
// (taraftan bağımsız), taraf değişimi dikey ayraçla gösterilir.
export default function MatchPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const round = Number(params.get('round') ?? '1');
  const seekTick = params.get('t') ? Number(params.get('t')) : null;

  const detail = useQuery({ queryKey: ['match', id], queryFn: () => api.matchDetail(id) });
  const summary = useQuery({
    queryKey: ['search', ''],
    queryFn: () => api.search(''),
    select: (d) => d.matches.find((m) => m.match_id === id),
  });

  if (detail.isLoading) return <p className="meta">loading…</p>;
  if (detail.error || !detail.data) return <p className="error">{String(detail.error)}</p>;
  const d = detail.data;
  const teams = { aId: d.team_a_id, a: d.team_a, b: d.team_b };

  // skor rauntlardan: kazanan taraf + o rauntta o tarafı oynayan takım
  let scoreA = 0, scoreB = 0;
  for (const r of d.rounds) {
    const c = winnerTeamClass(r, d.team_a_id);
    if (c === 'A') scoreA++;
    else if (c === 'B') scoreB++;
  }

  const setRound = (n: number) => {
    const p = new URLSearchParams(params);
    p.set('round', String(n));
    p.delete('t');
    setParams(p, { replace: true });
  };

  const header = (
    <div className="matchhead">
      {d.team_a_id
        ? <Link to={`/report/${d.team_a_id}?map=${d.map_name ?? ''}`} title="Opponent report">{d.team_a}</Link>
        : (d.team_a ?? 'Team A')}{' '}
      <span style={{ color: '#b6e2b6' }}>{scoreA} : {scoreB}</span>{' '}
      {d.team_b_id
        ? <Link to={`/report/${d.team_b_id}?map=${d.map_name ?? ''}`} title="Opponent report">{d.team_b}</Link>
        : (d.team_b ?? 'Team B')}
      <div className="meta">{d.map_name}{summary.data?.played_at ? ` · ${summary.data.played_at}` : ''}</div>
    </div>
  );

  return (
    <>
      <ReplayView
        header={header}
        key={id}
        matchId={id}
        round={round}
        onRound={setRound}
        seekTick={seekTick}
        matchKills={d.kills}
        rounds={d.rounds}
        teams={teams}
      />
    </>
  );
}
