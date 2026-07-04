import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { deleteLocal, listMatches, loadRegistry, type LocalMatchMeta } from '../lib/localdb';
import { processDem, scoreOf } from '../lib/localingest';

// Anonim tekil analiz: bir .dem seç, işlensin, izle. Sunucuda hiçbir şey
// kalmaz; sonuç yalnız bu tarayıcıda durur. Kalıcı arşiv isteyenler için
// Create DB sekmesi var.
export default function Analyze() {
  const [items, setItems] = useState<LocalMatchMeta[]>([]);
  const [phase, setPhase] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  const refresh = () => listMatches().then((l) =>
    setItems(l.filter((m) => (m.origin ?? 'single') === 'single')
      .sort((a, b) => b.saved_at.localeCompare(a.saved_at))));
  useEffect(() => { loadRegistry().then(refresh); }, []);

  async function handleFile(file: File) {
    setErr('');
    try {
      const id = await processDem(null, { name: file.name, getFile: async () => file }, 'single', setPhase);
      setPhase('');
      await refresh();
      nav(`/match/${id}`); // bitince doğrudan maça
    } catch (e) {
      setPhase('');
      setErr(String(e));
    }
  }

  return (
    <>
      <h1>Analyze a demo <span className="meta">— anonymous; nothing is kept on the server</span></h1>
      <p className="meta" style={{ maxWidth: 640 }}>
        Pick a .dem file. The server parses it, your browser keeps the result,
        and the server copy is deleted immediately — your match never joins the
        public site. You will be taken straight to the replay when it is ready.
        Building a whole archive of your demos? Use <Link to="/mydb">Create DB</Link>.
      </p>
      <div className="toolbar">
        <input
          ref={fileRef} type="file" accept=".dem" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleFile(f); }}
        />
        <button disabled={!!phase} onClick={() => fileRef.current?.click()}>
          {phase ? `${phase}…` : '⚡ pick a .dem file'}
        </button>
      </div>
      {err && <p className="error">{err}</p>}

      {items.length > 0 && (
        <>
          <h2>Previously analyzed <span className="meta">(in this browser)</span></h2>
          {items.map((m) => {
            const [sa, sb] = scoreOf(m.detail);
            return (
              <div key={m.match_id} className="matchrow" style={{ display: 'flex', alignItems: 'center' }}>
                <Link to={`/match/${m.match_id}`} style={{ flex: 1 }}>
                  <span className="vs">
                    <span>{m.detail.team_a ?? 'Team A'}</span>
                    <span className="score">{sa} : {sb}</span>
                    <span>{m.detail.team_b ?? 'Team B'}</span>
                  </span>
                </Link>
                <span className="badge gray">{m.detail.map_name}</span>
                <span className="meta">{m.saved_at.slice(0, 10)}</span>
                <button className="ghost" onClick={async () => { await deleteLocal(m.match_id); refresh(); }}>🗑</button>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
