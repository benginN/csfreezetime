// Statik sitedeki Analyze: demo TARAYICIDA parse edilir (WASM) — dosya
// hiçbir sunucuya gitmez, sonuç My DB altyapısına (IndexedDB) yazılır ve
// normal maç sayfasında izlenir. Stüdyodaki /analyze bundan ayrıdır.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { importBundle, localIds } from '../lib/localdb';
import { parseDemoInBrowser } from '../lib/analyze/client';

const MB = 1048576;
const WARN_MB = 500;   // tek çekirdekte ~10+ sn ve belirgin RAM
const BLOCK_MB = 1400; // wasm bellek tavanına fazla yaklaşır

type Phase =
  | { s: 'idle' }
  | { s: 'working'; note: string; file: string }
  | { s: 'error'; note: string };

export default function WasmAnalyze() {
  const nav = useNavigate();
  const [ph, setPh] = useState<Phase>({ s: 'idle' });
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // gizli E2E kancası: ?auto=/ayni-origin/dosya.dem → dosyayı çekip akışı
  // otomatik koşar, sonucu konsola yazar (headless test/CI için; yalnız
  // aynı-origin göreli yol kabul edilir)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('auto');
    if (!p || !p.startsWith('/') || p.startsWith('//')) return;
    (async () => {
      try {
        const r = await fetch(p);
        const bl = await r.blob();
        console.log('AUTOTEST_START', p, bl.size);
        document.title = `AUTOTEST_RUNNING ${bl.size}`;
        await analyze(new File([bl], p.split('/').pop() ?? 'auto.dem'));
      } catch (err) {
        console.log('AUTOTEST_FAIL', String(err));
        document.title = `AUTOTEST_FAIL ${String(err)}`.slice(0, 120);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function analyze(file: File) {
    if (!file.name.toLowerCase().endsWith('.dem')) {
      setPh({ s: 'error', note: 'Only plain .dem files (unzip/unrar first).' });
      return;
    }
    const mb = file.size / MB;
    if (mb > BLOCK_MB) {
      setPh({ s: 'error', note: `This demo is ${mb.toFixed(0)} MB — beyond the browser's memory budget. The self-hosted studio handles any size.` });
      return;
    }
    if (mb > WARN_MB && !window.confirm(
      `${mb.toFixed(0)} MB demo: parsing may take ~15-30 s and use a few GB of RAM. Continue?`)) return;

    setPh({ s: 'working', note: 'reading file', file: file.name });
    try {
      const bundle = await parseDemoInBrowser(file,
        (p) => setPh({ s: 'working', note: p, file: file.name }));
      setPh({ s: 'working', note: 'saving to your browser', file: file.name });
      await importBundle({ ...bundle, name: file.name.replace(/\.dem$/i, '') }, file.size);
      localIds.add(bundle.match_id);
      console.log('AUTOTEST_OK', bundle.match_id,
        'rounds=' + bundle.detail.rounds.length, 'kills=' + bundle.detail.kills.length);
      if (document.title.startsWith('AUTOTEST')) {
        document.title = `AUTOTEST_OK ${bundle.match_id} r=${bundle.detail.rounds.length} k=${bundle.detail.kills.length}`;
      }
      nav(`/match/${bundle.match_id}`);
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      console.log('AUTOTEST_FAIL', note);
      if (document.title.startsWith('AUTOTEST')) document.title = `AUTOTEST_FAIL ${note}`.slice(0, 120);
      setPh({ s: 'error', note });
    }
  }

  const busy = ph.s === 'working';
  return (
    <>
      <h1>⚡ Analyze a demo — right here, in your browser</h1>
      <p className="meta" style={{ maxWidth: 640 }}>
        Pick a CS2 demo (<code>.dem</code>) and it is parsed <b>inside your
        browser</b> with the same engine that built this archive — the file
        never leaves your machine, nothing is uploaded anywhere. The result is
        stored locally (your browser only) and opens as a normal match page:
        2D replay, kill feed, grenades, heatmap.
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
          e.preventDefault(); setDrag(false);
          if (!busy && e.dataTransfer.files[0]) analyze(e.dataTransfer.files[0]);
        }}
      >
        <input ref={fileRef} type="file" accept=".dem" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && analyze(e.target.files[0])} />
        {ph.s === 'idle' && <>Drop a .dem file here, or click to browse</>}
        {ph.s === 'working' && (
          <>
            <div style={{ fontSize: 16 }}>⚙️ {ph.file}</div>
            <div className="meta" style={{ marginTop: 8 }}>{ph.note}…</div>
          </>
        )}
        {ph.s === 'error' && (
          <>
            <div style={{ fontSize: 16 }}>❌ {ph.note}</div>
            <button className="ghost" style={{ marginTop: 12 }}
              onClick={(e) => { e.stopPropagation(); setPh({ s: 'idle' }); }}>
              Try another demo
            </button>
          </>
        )}
      </div>
      <p className="meta" style={{ maxWidth: 640 }}>
        Notes: replay &amp; heatmap are fully supported; buy types, strategy
        labels and win-probability need the archive engine and appear only for
        archive matches. Big demos (500 MB+) take longer and use a few GB of
        RAM while parsing. Your analyzed matches stay in this browser until you
        clear site data.
      </p>
      <p className="meta" style={{ maxWidth: 640 }}>
        Got a whole <b>folder</b> of demos (scrims, a team archive)?{' '}
        <Link to="/mydb"><b>Build your own database →</b></Link> — same
        in-browser engine, plus local team reports and strategy clustering.
      </p>
    </>
  );
}
