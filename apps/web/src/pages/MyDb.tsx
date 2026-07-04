import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  deleteLocal, getDirHandle, importBundle, listMatches, loadRegistry,
  localIds, putMatch, putRound, saveDirHandle,
  type Bundle, type LocalMatchMeta,
} from '../lib/localdb';

// Create your own database: kullanıcı bilgisayarında bir demo klasörü tutar
// (eski test-data gibi), burada o klasörü seçer. İşlenmemiş .dem'ler sunucuya
// tek tek UĞRAR (private statü), sonuç paketi klasöre `.freezetime/` altına
// yazılır ve sunucu kopyası ANINDA silinir — sunucuda kalıcı hiçbir şey
// durmaz. Paketli klasör taşınabilirdir: başka makinede seçilince upload'sız
// saniyeler içinde içeri alınır. (Nihai hedef: WASM parser ile sunucuya hiç
// uğramamak — yol haritasında.)

type FileHandle = { getFile(): Promise<File>; name: string };
type DirHandle = {
  name: string;
  values(): AsyncIterable<{ kind: string; name: string } & FileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle & {
    createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission(o: { mode: string }): Promise<string>;
  requestPermission(o: { mode: string }): Promise<string>;
};

const BUNDLE_DIR = '.freezetime';

async function gzipJson(obj: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(obj)])
    .stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
async function gunzipJson<T>(f: File): Promise<T> {
  const stream = f.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

export default function MyDb() {
  const [items, setItems] = useState<LocalMatchMeta[]>([]);
  const [dirName, setDirName] = useState('');
  const [queue, setQueue] = useState<{ total: number; done: number; current: string } | null>(null);
  const [phase, setPhase] = useState('');
  const [err, setErr] = useState('');
  const dirRef = useRef<DirHandle | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);
  const fsSupported = 'showDirectoryPicker' in window;

  const refresh = () => listMatches().then((l) =>
    setItems(l.sort((a, b) => b.saved_at.localeCompare(a.saved_at))));
  useEffect(() => {
    loadRegistry().then(refresh);
    // önceki oturumun klasörü: izin hâlâ geçerliyse adını göster
    getDirHandle().then(async (h) => {
      if (!h) return;
      const d = h as DirHandle;
      if (await d.queryPermission({ mode: 'readwrite' }) === 'granted') {
        dirRef.current = d;
        setDirName(d.name);
      } else {
        setDirName(`${d.name} (re-grant needed)`);
      }
    }).catch(() => {});
  }, []);

  async function pickFolder() {
    setErr('');
    try {
      const d: DirHandle = await (window as unknown as {
        showDirectoryPicker(o: { mode: string }): Promise<DirHandle>;
      }).showDirectoryPicker({ mode: 'readwrite' });
      dirRef.current = d;
      setDirName(d.name);
      await saveDirHandle(d);
      await scanFolder();
    } catch (e) {
      if (!String(e).includes('AbortError')) setErr(String(e));
    }
  }

  async function reGrant() {
    const d = dirRef.current ?? (await getDirHandle()) as DirHandle | null;
    if (!d) return;
    if (await d.requestPermission({ mode: 'readwrite' }) === 'granted') {
      dirRef.current = d;
      setDirName(d.name);
      await scanFolder();
    }
  }

  // klasörü tara: paketliler anında içeri, ham .dem'ler işleme kuyruğuna
  async function scanFolder() {
    const dir = dirRef.current;
    if (!dir) return;
    setErr('');
    stopRef.current = false;

    const dems: FileHandle[] = [];
    const bundles = new Map<string, FileHandle>();
    for await (const e of dir.values()) {
      if (e.kind === 'file' && e.name.toLowerCase().endsWith('.dem')) dems.push(e);
    }
    try {
      const bd = await dir.getDirectoryHandle(BUNDLE_DIR);
      for await (const e of bd.values()) {
        if (e.kind === 'file' && e.name.endsWith('.json.gz')) {
          bundles.set(e.name.replace(/\.json\.gz$/, ''), e);
        }
      }
    } catch { /* paket klasörü henüz yok */ }

    // 1) paketleri hızla içeri al (upload yok)
    for (const [base, bh] of bundles) {
      if (stopRef.current) break;
      setPhase(`importing bundle: ${base}`);
      try {
        const file = await bh.getFile();
        const b = await gunzipJson<Bundle>(file);
        if (!localIds.has(b.match_id)) await importBundle(b, file.size);
      } catch { /* bozuk paket: dem yeniden işlenir */ }
    }
    await refresh();

    // 2) paketi olmayan .dem'leri sunucu üzerinden işle (transit; iz kalmaz)
    const pending = dems.filter((d) => !bundles.has(d.name.replace(/\.dem$/i, '')));
    setQueue({ total: pending.length, done: 0, current: '' });
    for (const [i, fh] of pending.entries()) {
      if (stopRef.current) break;
      setQueue({ total: pending.length, done: i, current: fh.name });
      try {
        await processDem(dir, fh);
      } catch (e) {
        setErr(`${fh.name}: ${String(e)}`);
      }
      await refresh();
    }
    setQueue(null);
    setPhase('');
  }

  async function processDem(dir: DirHandle | null, fh: FileHandle) {
    const file = await fh.getFile();
    setPhase('uploading');
    const form = new FormData();
    form.set('private', '1');
    form.set('demo', file);
    const up = await fetch('/api/v1/upload', { method: 'POST', body: form }).then((r) => r.json());
    if (up.error) throw new Error(up.error);
    const id: string = up.match_id;
    const publicCopy = !!up.public_copy;

    setPhase('processing');
    let done = false;
    for (let i = 0; i < 240; i++) {
      const st = await fetch(`/api/v1/matches/${id}/status`).then((r) => r.json());
      if (st.status === 'private' || st.status === 'ready') { done = true; break; }
      if (st.status === 'failed') throw new Error('demo could not be parsed');
      await new Promise((res) => setTimeout(res, 2000));
    }
    if (!done) throw new Error('processing timed out — rescan the folder to retry this demo');

    setPhase('downloading');
    const detail = await api.matchDetail(id);
    const players = await api.matchPlayers(id);
    const roundsData: Record<number, unknown> = {};
    let bytes = 0;
    for (const r of detail.rounds) {
      const t = await api.roundTicks(id, r.round_number);
      roundsData[r.round_number] = t;
      bytes += JSON.stringify(t).length;
      await putRound(id, r.round_number, t);
    }
    await putMatch({
      match_id: id, detail, players,
      saved_at: new Date().toISOString(),
      rounds: detail.rounds.length, bytes,
    });

    // paketi klasöre yaz (taşınabilirlik + yeniden kurulum upload'sız)
    if (dir) {
    setPhase('writing bundle');
    const bd = await dir.getDirectoryHandle(BUNDLE_DIR, { create: true });
    const out = await bd.getFileHandle(fh.name.replace(/\.dem$/i, '') + '.json.gz', { create: true });
    const w = await out.createWritable();
    await w.write(await gzipJson({ match_id: id, detail, players, rounds: roundsData }));
    await w.close();
    }

    // sunucudaki izi sil
    if (!publicCopy) {
      setPhase('removing server copy');
      await fetch(`/api/v1/private/${id}`, { method: 'DELETE' });
    }
  }

  const totalMB = items.reduce((a, m) => a + m.bytes, 0) / 1e6;

  return (
    <>
      <h1>Analyze your demos <span className="meta">— anonymous; nothing is kept on the server</span></h1>
      <p className="meta" style={{ maxWidth: 720 }}>
        Keep your demos in a folder (like a personal test-data). Pick it once:
        unprocessed demos are parsed one by one (the server keeps nothing —
        each copy is deleted right after your browser saves the result), and a
        portable bundle is written into <code>{BUNDLE_DIR}/</code> inside your
        folder. Re-selecting the folder later (or on another machine) restores
        the whole database in seconds, no uploads.
      </p>

      <div className="toolbar">
        {fsSupported ? (
          <>
            <button onClick={pickFolder} disabled={!!queue}>📁 {dirName ? 'change folder' : 'select your demo folder'}</button>
            {dirName && <span className="meta">{dirName}</span>}
            {dirName.includes('re-grant') && <button className="ghost" onClick={reGrant}>re-grant access</button>}
            {dirName && !queue && !dirName.includes('re-grant') && (
              <button className="ghost" onClick={scanFolder}>↻ rescan</button>
            )}
            {queue && <button className="ghost" onClick={() => { stopRef.current = true; }}>⏹ stop (resumes later)</button>}
          </>
        ) : (
          <span className="meta">folder mode needs Chrome or Edge — single demos work everywhere:</span>
        )}
        <input
          ref={fileRef} type="file" accept=".dem" style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            setErr('');
            setQueue({ total: 1, done: 0, current: file.name });
            try {
              // klasör seçiliyse paketi oraya da yaz; değilse yalnız tarayıcıya
              await processDem(dirRef.current, { name: file.name, getFile: async () => file });
              await refresh();
            } catch (e2) { setErr(String(e2)); }
            setQueue(null); setPhase('');
          }}
        />
        <button
          className={fsSupported ? 'ghost' : ''}
          disabled={!!queue}
          title="analyze one demo without setting up a folder"
          onClick={() => fileRef.current?.click()}
        >
          ⚡ analyze a single demo
        </button>
      </div>

      {queue && (
        <p className="meta">
          processing {queue.done + 1} / {queue.total}: <b>{queue.current}</b> — {phase}…
          <br />first setup can take a while; you can stop anytime and it resumes where it left off.
        </p>
      )}
      {!queue && phase && <p className="meta">{phase}…</p>}
      {err && <p className="error">{err}</p>}

      <h2>
        Matches <span className="meta">({items.length} · {totalMB.toFixed(0)} MB in this browser)</span>
        {items.length > 0 && (
          <Link to="/mydb/report" style={{ marginLeft: 12, fontSize: 13 }}>📊 your team report →</Link>
        )}
      </h2>
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
            className="ghost" title="remove from this browser (bundle in your folder stays)"
            onClick={async () => { await deleteLocal(m.match_id); refresh(); }}
          >
            🗑
          </button>
        </div>
      ))}
      {items.length === 0 && !queue && <p className="meta">No local matches yet — pick your folder.</p>}
    </>
  );
}
