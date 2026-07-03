import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import ReplayView from '../components/ReplayView';
import StackView from '../components/StackView';
import HeatView from '../components/HeatView';

// Maç sayfası: kompakt başlık + sekmeler. "İzle" varsayılan: rauntlar üstte,
// grafik hemen altında — arada boşluk yok.
export default function MatchPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'izle';
  const round = Number(params.get('round') ?? '1');
  const seekTick = params.get('t') ? Number(params.get('t')) : null;

  const detail = useQuery({ queryKey: ['match', id], queryFn: () => api.matchDetail(id) });
  const summary = useQuery({
    queryKey: ['search', ''],
    queryFn: () => api.search(''),
    select: (d) => d.matches.find((m) => m.match_id === id),
  });

  if (detail.isLoading) return <p className="meta">yükleniyor…</p>;
  if (detail.error || !detail.data) return <p className="error">{String(detail.error)}</p>;
  const d = detail.data;
  const s = summary.data;

  const setTab = (t: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', t);
    p.delete('t');
    setParams(p, { replace: true });
  };
  const setRound = (n: number) => {
    const p = new URLSearchParams(params);
    p.set('round', String(n));
    p.set('tab', 'izle');
    p.delete('t');
    setParams(p, { replace: true });
  };

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>
        {s ? (
          <>
            {s.team_a ?? 'Takım A'}{' '}
            <span style={{ color: '#b6e2b6' }}>{s.score_a} : {s.score_b}</span>{' '}
            {s.team_b ?? 'Takım B'}
          </>
        ) : 'Maç'}{' '}
        <span className="meta">{d.map_name}{s?.played_at ? ` · ${s.played_at}` : ''}</span>
      </h1>

      <div className="tabs">
        <button className={tab === 'izle' ? 'active' : ''} onClick={() => setTab('izle')}>İzle</button>
        <button className={tab === 'stack' ? 'active' : ''} onClick={() => setTab('stack')}>Üst üste bindir</button>
        <button className={tab === 'isi' ? 'active' : ''} onClick={() => setTab('isi')}>Isı haritası</button>
      </div>

      {tab === 'izle' && (
        <>
          <div className="roundchips">
            {d.rounds.map((r) => (
              <button
                key={r.round_number}
                className={`${r.winner_side ?? ''} ${r.round_number === round ? 'sel' : ''}`}
                onClick={() => setRound(r.round_number)}
                title={`${r.winner_side ?? '?'} · ${r.end_reason ?? ''}${r.bomb_site ? ' · bomba ' + r.bomb_site : ''} · T:${r.t_buy_type ?? '?'} CT:${r.ct_buy_type ?? '?'}`}
              >
                {r.round_number}
              </button>
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

      {tab === 'stack' && <StackView matchId={id} rounds={d.rounds} />}

      {tab === 'isi' && d.map_name && <HeatView matchId={id} mapName={d.map_name} />}
    </>
  );
}
