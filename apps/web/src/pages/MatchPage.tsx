import { Fragment } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { chipTitle, isSideSwap, winnerTeamClass } from '../lib/rounds';
import ReplayView from '../components/ReplayView';
import StackView from '../components/StackView';
import HeatView from '../components/HeatView';

// Maç sayfası: kompakt başlık + sekmeler. Çipler kazanan TAKIM renginde
// (taraftan bağımsız), taraf değişimi dikey ayraçla gösterilir.
export default function MatchPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'watch';
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

  const setTab = (t: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', t);
    p.delete('t');
    setParams(p, { replace: true });
  };
  const setRound = (n: number) => {
    const p = new URLSearchParams(params);
    p.set('round', String(n));
    p.set('tab', 'watch');
    p.delete('t');
    setParams(p, { replace: true });
  };

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>
        {d.team_a_id
          ? <Link to={`/report/${d.team_a_id}?map=${d.map_name ?? ''}`} title="Opponent report">{d.team_a}</Link>
          : (d.team_a ?? 'Team A')}{' '}
        <span style={{ color: '#b6e2b6' }}>{scoreA} : {scoreB}</span>{' '}
        {d.team_b_id
          ? <Link to={`/report/${d.team_b_id}?map=${d.map_name ?? ''}`} title="Opponent report">{d.team_b}</Link>
          : (d.team_b ?? 'Team B')}{' '}
        <span className="meta">{d.map_name}{summary.data?.played_at ? ` · ${summary.data.played_at}` : ''}</span>
      </h1>

      <div className="tabs">
        <button className={tab === 'watch' ? 'active' : ''} onClick={() => setTab('watch')}>Watch</button>
        <button className={tab === 'stack' ? 'active' : ''} onClick={() => setTab('stack')}>Overlay rounds</button>
        <button className={tab === 'heat' ? 'active' : ''} onClick={() => setTab('heat')}>Heatmap</button>
      </div>

      {tab === 'watch' && (
        <>
          <div className="chiplegend">
            <span><i style={{ background: '#86d8e8' }} />{d.team_a ?? 'Team A'}</span>
            <span><i style={{ background: '#dcaaea' }} />{d.team_b ?? 'Team B'}</span>
            <span><span className="sideT" />won as T</span>
            <span><span className="sideCT" />won as CT</span>
            <span className="meta">| = side swap</span>
          </div>
          <div className="roundchips">
            {d.rounds.map((r, i) => (
              <Fragment key={r.round_number}>
                {isSideSwap(d.rounds[i - 1], r) && <span className="halfdiv" title="side swap" />}
                <button
                  className={`${winnerTeamClass(r, d.team_a_id)} win${r.winner_side ?? ''} ${r.round_number === round ? 'sel' : ''}`}
                  onClick={() => setRound(r.round_number)}
                  title={chipTitle(r, teams)}
                >
                  {r.round_number}
                </button>
              </Fragment>
            ))}
          </div>
          <ReplayView
            key={`${id}-${round}`}
            matchId={id}
            round={round}
            seekTick={seekTick}
            matchKills={d.kills}
          />
        </>
      )}

      {tab === 'stack' && <StackView matchId={id} rounds={d.rounds} teams={teams} />}

      {tab === 'heat' && d.map_name && (
        <HeatView matchId={id} mapName={d.map_name} rounds={d.rounds} teams={teams} />
      )}
    </>
  );
}
