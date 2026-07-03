import { useRef, useState } from 'react';
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

      <p className="meta">
        Note: strategy clusters and tendencies for a new demo are refreshed the
        next time the stats jobs (ml-jobs) run. Accounts and private demo spaces
        arrive with the production-readiness phase.
      </p>
    </>
  );
}
