import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export default function MatchDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();

  const detail = useQuery({ queryKey: ['match', id], queryFn: () => api.matchDetail(id) });
  const matches = useQuery({ queryKey: ['matches', ''], queryFn: () => api.matches() });

  if (detail.isLoading) return <p className="meta">yükleniyor…</p>;
  if (detail.error || !detail.data) return <p className="error">{String(detail.error)}</p>;
  const d = detail.data;
  const summary = (matches.data ?? []).find((m) => m.match_id === id);

  return (
    <>
      <h1>
        {summary ? (
          <>
            {summary.team_a ?? 'Takım A'}{' '}
            <span style={{ color: '#b6e2b6' }}>
              {summary.score_a} : {summary.score_b}
            </span>{' '}
            {summary.team_b ?? 'Takım B'}
          </>
        ) : (
          'Maç'
        )}{' '}
        <span className="meta">
          {d.map_name}
          {summary?.name ? ` · ${summary.name}` : ''}
        </span>
      </h1>

      <h2>Rauntlar</h2>
      <div className="round-strip">
        {d.rounds.map((r) => (
          <Link
            key={r.round_number}
            to={`/match/${id}/round/${r.round_number}`}
            className={r.winner_side ?? ''}
            title={`r${r.round_number} · ${r.winner_side ?? '?'} · ${r.end_reason ?? ''}${r.bomb_site ? ` · bomba ${r.bomb_site}` : ''}`}
          >
            {r.round_number}
          </Link>
        ))}
      </div>
      <p className="meta">
        Kutuya tıkla → raunt replay'i. Renk kazanan tarafı gösterir (turuncu T, mavi CT).
      </p>

      <h2>Raunt detayları</h2>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>#</th><th>Kazanan</th><th>Bitiş</th><th>Bomba</th>
              <th>T buy</th><th>CT buy</th><th>Kill</th>
            </tr>
          </thead>
          <tbody>
            {d.rounds.map((r) => {
              const kc = d.kills.filter((k) => k.round_number === r.round_number).length;
              return (
                <tr
                  key={r.round_number}
                  className="clickable"
                  onClick={() => nav(`/match/${id}/round/${r.round_number}`)}
                >
                  <td>{r.round_number}</td>
                  <td>{r.winner_side && <span className={`badge ${r.winner_side}`}>{r.winner_side}</span>}</td>
                  <td>{r.end_reason ?? '—'}</td>
                  <td>{r.bomb_site ?? '—'}</td>
                  <td>{r.t_buy_type ?? '—'}</td>
                  <td>{r.ct_buy_type ?? '—'}</td>
                  <td>{kc}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Kill'ler</h2>
      <div className="panel" style={{ maxHeight: 360, overflow: 'auto' }}>
        <table>
          <thead>
            <tr><th>Raunt</th><th>Zaman</th><th>Saldıran</th><th>Kurban</th><th>Silah</th><th>HS</th></tr>
          </thead>
          <tbody>
            {d.kills.map((k, i) => (
              <tr key={i} className="clickable" onClick={() => nav(`/match/${id}/round/${k.round_number}?t=${k.tick}`)}>
                <td>{k.round_number}</td>
                <td>{Math.floor(k.round_time / 60)}:{String(Math.floor(k.round_time % 60)).padStart(2, '0')}</td>
                <td>{k.attacker ?? '?'}</td>
                <td>{k.victim ?? '?'}</td>
                <td>{k.weapon ?? '?'}</td>
                <td>{k.headshot ? '✓' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
