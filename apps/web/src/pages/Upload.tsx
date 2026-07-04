import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

type Phase = 'idle' | 'uploading' | 'queued' | 'parsing' | 'enriching' | 'ready' | 'failed' | 'error';

interface UploadState {
  phase: Phase;
  progress: number;      // 0-100 (yükleme)
  matchId: string | null;
  message: string;
  duplicate: boolean;
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: '',
  uploading: 'Uploading…',
  queued: 'Queued — waiting for parser',
  parsing: 'Parsing demo…',
  enriching: 'Computing stats…',
  ready: 'Ready! ✅',
  failed: 'Processing failed ❌',
  error: 'Error',
};

export default function Upload() {
  // Kamu arşivine ekleme kapısı — YALNIZ yönetici. Kullanıcıların kendi
  // demoları için doğru yer My DB (sunucuda hiçbir şey tutulmaz).
  if (!localStorage.getItem('tm_admin')) {
    return (
      <>
        <h1>Upload</h1>
        <p className="meta" style={{ maxWidth: 560 }}>
          This page adds matches to the public archive and is curator-only.
          Looking to analyze your own demos? Use <Link to="/mydb">My database</Link> —
          your matches stay on your machine and never join the public site.
        </p>
      </>
    );
  }
  const [st, setSt] = useState<UploadState>({
    phase: 'idle', progress: 0, matchId: null, message: '', duplicate: false,
  });
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  function startUpload(file: File) {
    if (!file.name.toLowerCase().endsWith('.dem')) {
      setSt({ ...st, phase: 'error', message: 'Only .dem files are accepted.' });
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    setSt({ phase: 'uploading', progress: 0, matchId: null, message: '', duplicate: false });

    const form = new FormData();
    // tarayıcının bildiği son değişiklik tarihi ≈ maç tarihi
    form.set('played_at', new Date(file.lastModified).toISOString());
    form.set('demo', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setSt((s) => ({ ...s, progress: Math.round((100 * e.loaded) / e.total) }));
      }
    };
    xhr.onerror = () => setSt((s) => ({ ...s, phase: 'error', message: 'Connection error.' }));
    xhr.onload = () => {
      try {
        const resp = JSON.parse(xhr.responseText);
        if (xhr.status !== 200) {
          setSt((s) => ({ ...s, phase: 'error', message: resp.error ?? `HTTP ${xhr.status}` }));
          return;
        }
        if (resp.duplicate) {
          setSt({ phase: 'ready', progress: 100, matchId: resp.match_id, message: 'This demo was already processed.', duplicate: true });
          return;
        }
        setSt({ phase: 'queued', progress: 100, matchId: resp.match_id, message: '', duplicate: false });
        poll(resp.match_id);
      } catch {
        setSt((s) => ({ ...s, phase: 'error', message: 'Unexpected response.' }));
      }
    };
    xhr.send(form);
  }

  function poll(matchId: string) {
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/v1/matches/${matchId}/status`);
        const j = await r.json();
        const phase = (['queued', 'parsing', 'enriching', 'ready', 'failed'] as Phase[])
          .includes(j.status) ? (j.status as Phase) : 'queued';
        setSt((s) => ({ ...s, phase }));
        if (phase === 'ready' || phase === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch { /* geçici ağ hatası — sonraki turda dener */ }
    }, 2000);
  }

  const busy = st.phase === 'uploading';

  return (
    <>
      <h1>Upload demo</h1>
      <p className="meta">
        Upload your own .dem file; it gets processed automatically and becomes a
        match you can analyze (replay, heatmap, round overlay). Uploading the
        same demo twice won't reprocess it — you'll be pointed to the existing match.
      </p>

      <div
        className="panel"
        style={{
          border: drag ? '2px dashed #4c8f52' : '2px dashed #313833',
          textAlign: 'center', padding: '48px 20px', cursor: busy ? 'default' : 'pointer',
        }}
        onClick={() => !busy && fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!busy && e.dataTransfer.files[0]) startUpload(e.dataTransfer.files[0]);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".dem"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && startUpload(e.target.files[0])}
        />
        {st.phase === 'idle' && <>Drop a .dem file here, or click to browse</>}
        {st.phase === 'uploading' && (
          <>
            <div>Uploading… {st.progress}%</div>
            <div style={{ maxWidth: 420, margin: '12px auto 0', background: '#232a26', borderRadius: 4, height: 10 }}>
              <div style={{ width: `${st.progress}%`, height: '100%', background: '#4c8f52', borderRadius: 4 }} />
            </div>
          </>
        )}
        {st.phase !== 'idle' && st.phase !== 'uploading' && (
          <>
            <div style={{ fontSize: 16 }}>{PHASE_TEXT[st.phase]}</div>
            {st.message && <div className="meta" style={{ marginTop: 6 }}>{st.message}</div>}
            {st.phase === 'ready' && st.matchId && (
              <div style={{ marginTop: 14 }}>
                <Link to={`/match/${st.matchId}`}><button>Open match →</button></Link>
              </div>
            )}
            {(st.phase === 'ready' || st.phase === 'failed' || st.phase === 'error') && (
              <div style={{ marginTop: 10 }}>
                <button className="ghost" onClick={(e) => {
                  e.stopPropagation();
                  setSt({ phase: 'idle', progress: 0, matchId: null, message: '', duplicate: false });
                }}>
                  Upload another demo
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {localStorage.getItem('tm_admin') && (
        <>
          <BackfillPanel />
          <CoveragePanel />
        </>
      )}

      <p className="meta">
        Curator note: stats (clusters, tendencies, tournament labels) refresh
        automatically once the ingest queue settles.
      </p>
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
