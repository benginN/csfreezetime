import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { playUrl } from './Playlists';
import { localIds } from '../lib/localdb';
import { winnerTeamClass } from '../lib/rounds';
import ReplayView from '../components/ReplayView';

// Maç sayfası: kompakt başlık + sekmeler. Çipler kazanan TAKIM renginde
// (taraftan bağımsız), taraf değişimi dikey ayraçla gösterilir.
export default function MatchPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const isLocal = localIds.has(id);
  const round = Number(params.get('round') ?? '1');
  const seekTick = params.get('t') ? Number(params.get('t')) : null;
  const seekSec = params.get('ts') ? Number(params.get('ts')) : null;

  // playlist modu: ?playlist=ID&idx=N — raunt bitince otomatik sıradaki
  const plId = params.get('playlist');
  const plIdx = Number(params.get('idx') ?? '0');
  const pl = useQuery({
    queryKey: ['playlist', plId],
    queryFn: () => api.playlist(plId!),
    enabled: !!plId && !isLocal,
  });

  const detail = useQuery({ queryKey: ['match', id], queryFn: () => api.matchDetail(id) });
  const summary = useQuery({
    queryKey: ['search', ''],
    queryFn: () => api.search(''),
    select: (d) => d.matches.find((m) => m.match_id === id),
    enabled: !isLocal,
  });
  // Parça demo (…-p1/-p2) ise kardeş parçaları bul
  const partM = /^(.*)-p(\d)$/.exec(summary.data?.name ?? '');
  const siblings = useQuery({
    queryKey: ['parts', partM?.[1] ?? ''],
    queryFn: () => api.search(partM![1]),
    enabled: !!partM,
    select: (d) => d.matches
      .filter((m) => m.match_id !== id && (m.name ?? '').startsWith(partM![1] + '-p'))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
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
      <div className="meta">
        {isLocal && <span className="badge gray" style={{ marginRight: 6 }}>💾 local</span>}
        {d.map_name}
        {d.tournament ? ` · ${d.tournament.replace(/-/g, ' ')}` : ''}
        {summary.data?.played_at ? ` · ${summary.data.played_at}` : ''}
        {d.team_a_id && d.team_b_id && (
          <>
            {' '}
            <Link
              to={`/compare?a=${d.team_a_id}&b=${d.team_b_id}&map=${d.map_name ?? ''}`}
              title="head-to-head report for these teams on this map"
            >
              📊
            </Link>
          </>
        )}
      </div>
    </div>
  );

  // parçalı kayıt: önceki parçaların raunt toplamı = görünen numara ofseti
  const partNo = partM ? Number(partM[2]) : 1;
  const roundOffset = (siblings.data ?? [])
    .filter((sb) => {
      const n = /-p(\d)$/.exec(sb.name ?? '')?.[1];
      return n != null && Number(n) < partNo;
    })
    .reduce((a, sb) => a + sb.score_a + sb.score_b, 0);

  const plItems = pl.data?.items ?? [];
  const goPl = (idx: number) => {
    if (!plId || idx < 0 || idx >= plItems.length) return;
    nav(playUrl(plItems, idx, plId));
  };

  return (
    <>
      {partM && (
        <div className="toolbar" style={{ background: '#1a1712', border: '1px solid #33291c', borderRadius: 8, padding: '6px 10px' }}>
          <span className="meta">
            ⚠ split recording — this is <b>part {partM[2]}</b> of this map
            {roundOffset > 0 && <> (rounds continue from <b>{roundOffset + 1}</b>)</>}
          </span>
          {(siblings.data ?? []).map((sb) => {
            const n = /-p(\d)$/.exec(sb.name ?? '')?.[1];
            return <Link key={sb.match_id} to={`/match/${sb.match_id}`}>watch part {n} →</Link>;
          })}
        </div>
      )}
      {plId && pl.data && (
        <div className="toolbar" style={{ background: '#151a17', border: '1px solid #232a26', borderRadius: 8, padding: '6px 10px' }}>
          <span>🎬 <b>{pl.data.name}</b></span>
          <span className="meta">{plIdx + 1} / {plItems.length}</span>
          <button className="ghost" disabled={plIdx <= 0} onClick={() => goPl(plIdx - 1)}>← prev</button>
          <button className="ghost" disabled={plIdx >= plItems.length - 1} onClick={() => goPl(plIdx + 1)}>next →</button>
          {plItems[plIdx]?.note && <span className="meta">“{plItems[plIdx].note}”</span>}
          <Link to="/playlists" className="meta">exit</Link>
        </div>
      )}
      <ReplayView
        header={header}
        key={id}
        matchId={id}
        round={round}
        onRound={setRound}
        seekTick={seekTick}
        seekSec={seekSec}
        matchKills={d.kills}
        rounds={d.rounds}
        teams={teams}
        onEnded={plId ? () => goPl(plIdx + 1) : undefined}
        localMode={isLocal}
        roundOffset={roundOffset}
      />
    </>
  );
}
