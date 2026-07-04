import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  deleteLocal, listMatches, loadRegistry, putMatch, putRound,
  type LocalMatchMeta,
} from '../lib/localdb';

// Create your own database: kullanıcı (ör. alt lig analisti) kendi
// demolarını yükler; sunucu İŞLER ama SAKLAMAZ — rauntlar tarayıcının
// IndexedDB'sine iner, sunucudaki iz silinir. Liste ve replay tamamen
// lokalden çalışır.
export default function MyDb() {
  const [items, setItems] = useState<LocalMatchMeta[]>([]);
  const [phase, setPhase] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => listMatches().then((l) =>
    setItems(l.sort((a, b) => b.saved_at.localeCompare(a.saved_at))));
  useEffect(() => { loadRegistry().then(refresh); }, []);

  async function handleFile(file: File) {
    setErr('');
    try {
      // 1) sunucuya işlet (private statü: arşive/istatistiklere karışmaz)
      setPhase('uploading…');
      const form = new FormData();
      form.set('private', '1');
      form.set('demo', file);
      const up = await fetch('/api/v1/upload', { method: 'POST', body: form })
        .then((r) => r.json());
      if (up.error) throw new Error(up.error);
      const id: string = up.match_id;
      const publicCopy: boolean = !!up.public_copy;

      // 2) işlenene dek bekle
      setPhase('processing…');
      for (let i = 0; i < 240; i++) {
        const st = await fetch(`/api/v1/matches/${id}/status`).then((r) => r.json());
        if (st.status === 'private' || st.status === 'ready') break;
        if (st.status === 'failed') throw new Error('demo could not be parsed');
        await new Promise((res) => setTimeout(res, 2000));
      }

      // 3) rauntları tarayıcıya indir
      const detail = await api.matchDetail(id);
      const players = await api.matchPlayers(id);
      let bytes = 0;
      for (const r of detail.rounds) {
        setPhase(`saving to your browser… round ${r.round_number}/${detail.rounds.length}`);
        const t = await api.roundTicks(id, r.round_number);
        bytes += JSON.stringify(t).length;
        await putRound(id, r.round_number, t);
      }
      await putMatch({
        match_id: id, detail, players,
        saved_at: new Date().toISOString(),
        rounds: detail.rounds.length, bytes,
      });

      // 4) sunucudaki izi sil (kamu kopyasıysa dokunma)
      if (!publicCopy) {
        setPhase('removing server copy…');
        await fetch(`/api/v1/private/${id}`, { method: 'DELETE' });
      }
      setPhase('');
      refresh();
    } catch (e) {
      setPhase('');
      setErr(String(e));
    }
  }

  const totalMB = items.reduce((a, m) => a + m.bytes, 0) / 1e6;

  return (
    <>
      <h1>My database <span className="meta">— stored in this browser, not on the server</span></h1>
      <p className="meta">
        Upload your own demos (scrims, low-tier officials…). The server parses
        them, your browser keeps the result, and the server copy is deleted —
        your data stays yours. Replay works fully; heatmap/ghost layers need
        the server archive and are disabled for local matches.
      </p>
      <div className="toolbar">
        <input
          ref={fileRef} type="file" accept=".dem" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <button disabled={!!phase} onClick={() => fileRef.current?.click()}>
          {phase || '⬆ add a demo'}
        </button>
        {items.length > 0 && <span className="meta">{items.length} matches · {totalMB.toFixed(0)} MB local</span>}
      </div>
      {err && <p className="error">{err}</p>}

      {items.map((m) => (
        <div key={m.match_id} className="matchrow" style={{ display: 'flex', alignItems: 'center' }}>
          <Link to={`/match/${m.match_id}`} style={{ flex: 1 }}>
            <span className="vs">
              <span>{m.detail.team_a ?? 'Team A'}</span>
              <span className="score">vs</span>
              <span>{m.detail.team_b ?? 'Team B'}</span>
            </span>
          </Link>
          <span className="badge gray">{m.detail.map_name}</span>
          <span className="meta">{m.rounds} rounds · {(m.bytes / 1e6).toFixed(1)} MB · {m.saved_at.slice(0, 10)}</span>
          <button
            className="ghost" title="remove from this browser"
            onClick={async () => { await deleteLocal(m.match_id); refresh(); }}
          >
            🗑
          </button>
        </div>
      ))}
      {items.length === 0 && !phase && <p className="meta">No local matches yet.</p>}
    </>
  );
}
