import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

// /archive — küratörün arşiv kapsamı panosu (yalnız coverage). Backfill
// durum paneli kaldırıldı (2026-07-12): işleme zaten otomatik ve terminal/
// asistan tarafından izleniyor; buranın değeri turnuva bazında "eksik maç
// var mı" bakışı. Kamu arşivini besleyen tek yol backfill/ klasörü; kişisel
// demolar → /analyze.
export default function Upload() {
  if (!localStorage.getItem('tm_admin')) {
    return <Navigate to="/analyze" replace />;
  }
  return (
    <>
      <h1>Archive</h1>
      <p className="meta" style={{ maxWidth: 640 }}>
        Tournament-by-tournament coverage of the public archive. The archive is
        fed by dropping demo archives into the server's <code>backfill/</code>{' '}
        folder (processed automatically); personal demos go through{' '}
        <a href="/analyze">Analyze</a> and never appear here.
      </p>
      <CoveragePanel />
    </>
  );
}

function CoveragePanel() {
  const [d, setD] = useState<{
    totals: { matches: number; rounds: number; teams: number; oldest: string; newest: string } | null;
    maps: { map_name: string; matches: number }[];
    teams: { name: string; matches: number; latest: string }[];
    tournaments: { tournament: string; matches: number; latest: string }[];
  } | null>(null);
  useEffect(() => {
    fetch('/api/v1/coverage', { headers: adminHeaders() }).then((r) => r.json()).then(setD).catch(() => {});
  }, []);
  if (!d?.totals) return null;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>
        Archive coverage{' '}
        <span className="meta">
          {d.totals.matches} matches · {d.totals.rounds} rounds · {d.totals.teams} teams
          · {d.totals.oldest} → {d.totals.newest}
        </span>
      </h2>
      <div className="grid cards two">
        <div className="card">
          <div className="meta" style={{ marginBottom: 6 }}>by tournament</div>
          <table>
            <tbody>
              {(d.tournaments ?? []).map((t) => (
                <tr key={t.tournament}>
                  <td className="cut">{t.tournament.replace(/-/g, ' ')}</td>
                  <td>{t.matches}</td>
                  <td className="meta">{t.latest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="meta" style={{ marginBottom: 6 }}>by map</div>
          <table>
            <tbody>
              {d.maps.map((m) => (
                <tr key={m.map_name}><td>{m.map_name}</td><td>{m.matches}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="meta" style={{ marginBottom: 6 }}>by team (latest match)</div>
          <table>
            <tbody>
              {d.teams.slice(0, 14).map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td><td>{t.matches}</td>
                  <td className="meta">{t.latest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


function adminHeaders(): Record<string, string> {
  const t = localStorage.getItem('tm_admin');
  return t ? { 'X-Admin-Token': t } : {};
}
