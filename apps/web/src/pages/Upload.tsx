import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';

// /upload — YALNIZ küratör panosu (backfill durumu + kapsam). Kamu arşivini
// besleyen tek yol sunucudaki backfill/ klasörüdür (izleyici otomatik işler).
// Buradaki eski tek-dosya kamu yükleme formu KALDIRILDI (2026-07-12): kişisel
// demolar yanlışlıkla kamu arşivine karışıyordu. Kendi demosunu izlemek
// isteyen herkes (küratör dahil) → /analyze (private işler, arşive dokunmaz).
export default function Upload() {
  if (!localStorage.getItem('tm_admin')) {
    return <Navigate to="/analyze" replace />;
  }
  return (
    <>
      <h1>Curator panel</h1>
      <p className="meta" style={{ maxWidth: 640 }}>
        The public archive is fed by dropping demo archives into the server's{' '}
        <code>backfill/</code> folder — the watcher picks them up automatically,
        and stats (clusters, tendencies, tournament labels) refresh once the
        queue settles. Analyzing a personal demo? Use <a href="/analyze">Analyze</a>{' '}
        instead — it never touches the archive.
      </p>
      <BackfillPanel />
      <CoveragePanel />
    </>
  );
}

// Toplu backfill: sunucudaki backfill klasörüne .rar/.zip/.dem yığ → Scan.
// HLTV turnuva arşivleri (BO3 rar'ı = 3 demo) tek seferde açılıp işlenir.
function BackfillPanel() {
  const [status, setStatus] = useState<{
    running: boolean; total: number; done: number; current: string;
    results: { match_id?: string; source_file?: string; duplicate?: boolean; status?: string }[] | null;
    errors: string[] | null; dir: string;
  } | null>(null);
  const timerRef = useRef<number | null>(null);

  async function refresh() {
    const r = await fetch('/api/v1/backfill/status', { headers: adminHeaders() });
    const j = await r.json();
    setStatus(j);
    if (!j.running && timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }
  useEffect(() => { refresh(); }, []);

  async function scan() {
    const r = await fetch('/api/v1/backfill/scan', { method: 'POST', headers: adminHeaders() });
    await r.json();
    await refresh();
    if (!timerRef.current) timerRef.current = window.setInterval(refresh, 2000);
  }

  const st = status;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Bulk backfill</h2>
      <p className="meta">
        Drop tournament archives (.rar / .zip — e.g. HLTV downloads) or bare
        demos into <code>{st?.dir ?? 'backfill'}/</code> on the server, then scan.
        Every .dem inside is extracted and queued; duplicates are skipped by
        hash, processed archives move to <code>done/</code>.
      </p>
      <div className="toolbar">
        <button onClick={scan} disabled={st?.running}>
          {st?.running ? `processing ${st.done}/${st.total} — ${st.current}` : 'Scan & process folder'}
        </button>
        {!st?.running && st?.results && (
          <span className="meta">
            last run: {st.results.length} demos
            {st.results.filter((x) => x.duplicate).length > 0 &&
              ` (${st.results.filter((x) => x.duplicate).length} already known)`}
          </span>
        )}
      </div>
      {st?.errors && st.errors.length > 0 && (
        <div className="error" style={{ fontSize: 12 }}>
          {st.errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
    </div>
  );
}

// Kapsam envanteri: içeride ne var — takım/harita/tarih dağılımı.
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
