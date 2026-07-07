import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SearchResult } from '../api';
import {
  deleteLocal, deleteVoice, getDirHandle, importBundle, listMatches,
  listVoiceIds, loadRegistry, localIds, putVoice, saveDirHandle,
  type Bundle, type LocalMatchMeta,
} from '../lib/localdb';
import {
  BUNDLE_DIR, gunzipJson, importPublicMatch, processDem, scoreOf,
  type DirHandle, type FileHandle,
} from '../lib/localingest';

// Create your own database: bilgisayarındaki demo klasörünü seç; işlenmemişler
// sırayla işlenir (sunucu saklamaz), paketler klasöre yazılır (taşınabilir),
// arşivin bu tarayıcıda yaşar. Tekil hızlı analiz için Analyze sekmesi.
export default function MyDb() {
  const [items, setItems] = useState<LocalMatchMeta[]>([]);
  const [voiceIds, setVoiceIds] = useState<Set<string>>(new Set());
  const voiceTargetRef = useRef<LocalMatchMeta | null>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [dirName, setDirName] = useState('');
  const [queue, setQueue] = useState<{ total: number; done: number; current: string } | null>(null);
  const [phase, setPhase] = useState('');
  const [err, setErr] = useState('');
  const dirRef = useRef<DirHandle | null>(null);
  const stopRef = useRef(false);
  const fsSupported = 'showDirectoryPicker' in window;

  const refresh = () => Promise.all([listMatches(), listVoiceIds()]).then(([l, v]) => {
    setItems(l.filter((m) => ['folder', 'archive'].includes(m.origin ?? 'folder'))
      .sort((a, b) => b.saved_at.localeCompare(a.saved_at)));
    setVoiceIds(v);
  });

  // 🎙 telsiz kaydı ekle: IndexedDB'ye + (klasör varsa) taşınabilir kopya
  async function attachVoice(f: File) {
    const m = voiceTargetRef.current;
    if (!m) return;
    await putVoice(m.match_id, f);
    const dir = dirRef.current;
    if (dir && m.name) {
      try {
        const bd = await dir.getDirectoryHandle(BUNDLE_DIR, { create: true });
        const ext = (f.name.split('.').pop() ?? 'ogg').toLowerCase();
        const out = await bd.getFileHandle(`${m.name}.comms.${ext}`, { create: true });
        const w = await out.createWritable();
        await w.write(f);
        await w.close();
      } catch { /* klasör kopyası isteğe bağlı */ }
    }
    await refresh();
  }
  useEffect(() => {
    loadRegistry().then(refresh);
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

  async function scanFolder() {
    const dir = dirRef.current;
    if (!dir) return;
    setErr('');
    stopRef.current = false;

    const dems: FileHandle[] = [];
    const bundles = new Map<string, FileHandle>();
    const commsFiles = new Map<string, FileHandle>();
    for await (const e of dir.values()) {
      if (e.kind === 'file' && e.name.toLowerCase().endsWith('.dem')) dems.push(e);
    }
    try {
      const bd = await dir.getDirectoryHandle(BUNDLE_DIR);
      for await (const e of bd.values()) {
        if (e.kind === 'file' && e.name.endsWith('.json.gz')) {
          bundles.set(e.name.replace(/\.json\.gz$/, ''), e);
        }
        if (e.kind === 'file' && /\.comms\.\w+$/.test(e.name)) {
          commsFiles.set(e.name.replace(/\.comms\.\w+$/, ''), e);
        }
      }
    } catch { /* paket klasörü henüz yok */ }

    for (const [base, bh] of bundles) {
      if (stopRef.current) break;
      setPhase(`importing bundle: ${base}`);
      try {
        const file = await bh.getFile();
        const b = await gunzipJson<Bundle>(file);
        if (!localIds.has(b.match_id)) await importBundle({ ...b, name: b.name ?? base }, file.size);
      } catch { /* bozuk paket: dem yeniden işlenir */ }
    }
    setPhase('');
    await refresh();

    // 🎙 klasördeki telsiz kayıtlarını geri yükle (<demo adı>.comms.<uzantı>)
    if (commsFiles.size) {
      const all = await listMatches();
      const have = await listVoiceIds();
      for (const [base, fh] of commsFiles) {
        const m = all.find((x) => x.name === base);
        if (m && !have.has(m.match_id)) {
          try { await putVoice(m.match_id, await fh.getFile()); } catch { /* bozuk dosya: atla */ }
        }
      }
      await refresh();
    }

    const pending = dems.filter((d) => !bundles.has(d.name.replace(/\.dem$/i, '')));
    setQueue({ total: pending.length, done: 0, current: '' });
    for (const [i, fh] of pending.entries()) {
      if (stopRef.current) break;
      setQueue({ total: pending.length, done: i, current: fh.name });
      try {
        await processDem(dir, fh, 'folder', setPhase);
      } catch (e) {
        setErr(`${fh.name}: ${String(e)}`);
      }
      await refresh();
    }
    setQueue(null);
    setPhase('');
  }

  // arama + parça gruplama
  const ql = q.trim().toLowerCase();
  const filtered = !ql ? items : items.filter((m) =>
    [m.detail.team_a, m.detail.team_b, m.detail.map_name, m.name,
      ...m.players.map((p) => p.nickname)]
      .some((x) => x?.toLowerCase().includes(ql)));
  const grouped = groupLocalParts(filtered);
  const totalMB = items.reduce((a, m) => a + m.bytes, 0) / 1e6;

  // arama önerileri: eşleşen takım/oyuncu çipleri (ana sayfadaki gibi,
  // ama LOKAL rapora giderler — sunucu verisiyle karışmaz)
  const teamHits = !ql ? [] : [...new Set(items
    .flatMap((m) => [m.detail.team_a, m.detail.team_b])
    .filter((t): t is string => !!t && t.toLowerCase().includes(ql)))].slice(0, 6);
  const playerHits = !ql ? [] : [...new Set(items
    .flatMap((m) => m.players.filter((p) => !p.is_coach).map((p) => p.nickname))
    .filter((n) => n.toLowerCase().includes(ql)))].slice(0, 8);

  return (
    <>
      <h1>Create your own database <span className="meta">— lives in your folder + this browser, never on the server</span></h1>
      <p className="meta" style={{ maxWidth: 720 }}>
        Keep your demos in a folder (a personal test-data). Pick it once:
        unprocessed demos are parsed one by one — the server keeps nothing —
        and portable bundles are written into <code>{BUNDLE_DIR}/</code> inside
        your folder. Re-selecting the folder later (or on another machine)
        restores everything in seconds. One-off analysis lives in{' '}
        <Link to="/analyze">Analyze</Link>.
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
          <span className="meta">Folder mode needs Chrome or Edge; single demos work in <Link to="/analyze">Analyze</Link>.</span>
        )}
      </div>

      {queue && (
        <p className="meta">
          processing {queue.done + 1} / {queue.total}: <b>{queue.current}</b> — {phase}…
          <br />first setup can take a while; stop anytime, it resumes where it left off.
        </p>
      )}
      {!queue && phase && <p className="meta">{phase}…</p>}
      {err && <p className="error">{err}</p>}

      <ArchivePicker
        dirRef={dirRef}
        items={items}
        busy={!!queue}
        onImported={refresh}
      />

      <h2>
        Matches <span className="meta">({items.length} · {totalMB.toFixed(0)} MB in this browser)</span>
        {items.length > 0 && (
          <Link to="/mydb/report" style={{ marginLeft: 12, fontSize: 13 }}>📊 your team report →</Link>
        )}
      </h2>
      {items.length > 0 && (
        <div className="toolbar">
          <input
            style={{ width: 260 }}
            placeholder="search your database… (team, player, map, file)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {ql && <span className="meta">{grouped.length} results</span>}
        </div>
      )}
      {teamHits.length > 0 && (
        <div className="toolbar">
          <span className="meta">teams:</span>
          {teamHits.map((t) => (
            <Link key={t} to={`/mydb/report?team=${encodeURIComponent(t)}`}>
              <button className="ghost">🛡 {t} report</button>
            </Link>
          ))}
        </div>
      )}
      {playerHits.length > 0 && (
        <div className="toolbar">
          <span className="meta">players:</span>
          {playerHits.map((p) => (
            <button key={p} className="ghost" onClick={() => setQ(p)}>👤 {p}</button>
          ))}
        </div>
      )}

      {grouped.map((g) => (
        <div key={g.head.match_id} className="matchrow" style={{ display: 'flex', alignItems: 'center' }}>
          <Link to={`/match/${g.head.match_id}`} style={{ flex: 1 }}>
            <span className="vs">
              <span>{g.head.detail.team_a ?? 'Team A'}</span>
              <span className="score">{g.scoreA} : {g.scoreB}</span>
              <span>{g.head.detail.team_b ?? 'Team B'}</span>
            </span>
          </Link>
          <span className="badge gray">{g.head.detail.map_name}</span>
          {g.head.origin === 'archive' && (
            <span className="badge gray" title="copied from the public Freezetime archive — remove it like any other local match; the public site is unaffected">
              🌐 archive
            </span>
          )}
          {g.parts.length > 1 && (
            <span className="badge gray" title="split recording: parts play separately, score here is combined">
              {g.parts.length} parts
            </span>
          )}
          <span className="meta">
            {g.parts.reduce((a, p) => a + p.rounds, 0)} rounds ·{' '}
            {(g.parts.reduce((a, p) => a + p.bytes, 0) / 1e6).toFixed(1)} MB · {g.head.saved_at.slice(0, 10)}
          </span>
          <button
            className="ghost"
            title={voiceIds.has(g.head.match_id)
              ? 'voice comms attached — click to remove the recording'
              : 'attach team voice comms (mp3/ogg/wav) — plays synced inside the replay'}
            onClick={async () => {
              if (voiceIds.has(g.head.match_id)) {
                await deleteVoice(g.head.match_id);
                refresh();
              } else {
                voiceTargetRef.current = g.head;
                voiceInputRef.current?.click();
              }
            }}
          >
            {voiceIds.has(g.head.match_id) ? '🎙✓' : '🎙'}
          </button>
          <button
            className="ghost" title="remove from this browser (bundles in your folder stay)"
            onClick={async () => {
              for (const p of g.parts) await deleteLocal(p.match_id);
              refresh();
            }}
          >
            🗑
          </button>
        </div>
      ))}
      {items.length === 0 && !queue && <p className="meta">No local matches yet — pick your folder.</p>}
      <input
        ref={voiceInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) attachVoice(f);
        }}
      />
    </>
  );
}

// Kamu arşivinden maç seçip yerel veritabanına katma (kompozisyon):
// arama sunucuda koşar, seçilen maç indirildikten sonra tamamen yerelde
// yaşar. Rapor/kümeleme yerel maçların TÜMÜNÜ kullandığı için indirilen
// maçlar analize kendiliğinden dahil olur.
function ArchivePicker({ dirRef, items, busy, onImported }: {
  dirRef: React.MutableRefObject<DirHandle | null>;
  items: LocalMatchMeta[];
  busy: boolean;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [aq, setAq] = useState('');
  const [results, setResults] = useState<SearchResult['matches']>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [phase, setPhase] = useState('');
  const [err, setErr] = useState('');

  // yazdıkça sunucu araması (300 ms debounce)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.search(aq);
        setResults((r.matches ?? []).slice(0, 12));
      } catch (e) {
        setErr(String(e));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [aq, open]);

  const inDb = (id: string) => items.some((m) => m.match_id === id);

  async function add(m: SearchResult['matches'][number]) {
    setErr('');
    setAdding(m.match_id);
    try {
      // paket adı arşiv önekli: kendi demolarınla çakışmasın
      await importPublicMatch(dirRef.current, m.match_id,
        `archive-${m.name ?? m.match_id}`, setPhase);
      onImported();
    } catch (e) {
      setErr(`${m.name ?? m.match_id}: ${String(e)}`);
    } finally {
      setAdding(null);
      setPhase('');
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 🌐 Add matches from the Freezetime archive
      </h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        Mix public matches into your own database — for example, pull your next
        opponent&apos;s official maps in next to your scrims. Picked matches are
        downloaded <b>once</b> and then live entirely in your browser
        {dirRef.current ? ' (and as a bundle in your folder, so they restore with everything else)' : ''}.
        Your team report and strategy clustering include them automatically.
        Removing one later only affects your local copy — never the public site.
      </p>
      {open && (
        <>
          <div className="toolbar">
            <input
              style={{ width: 320 }}
              placeholder="search the archive… (team, map, tournament — e.g. 'vitality mirage')"
              value={aq}
              onChange={(e) => setAq(e.target.value)}
            />
            {searching && <span className="meta">searching…</span>}
          </div>
          {results.map((m) => (
            <div key={m.match_id} className="matchrow" style={{ display: 'flex', alignItems: 'center' }}>
              <span className="vs" style={{ flex: 1 }}>
                <span>{m.team_a ?? 'Team A'}</span>
                <span className="score">{m.score_a} : {m.score_b}</span>
                <span>{m.team_b ?? 'Team B'}</span>
              </span>
              <span className="badge gray">{m.map_name}</span>
              <span className="meta">{m.played_at ?? ''}{m.tournament ? ` · ${m.tournament.replace(/-/g, ' ')}` : ''}</span>
              {inDb(m.match_id) ? (
                <span className="badge gray">✓ in your DB</span>
              ) : (
                <button
                  className="ghost"
                  disabled={busy || adding !== null}
                  onClick={() => add(m)}
                >
                  {adding === m.match_id ? `⏳ ${phase || 'adding'}…` : '+ add'}
                </button>
              )}
            </div>
          ))}
          {!results.length && !searching && (
            <p className="meta">no matches — try a team, map or tournament name</p>
          )}
          {err && <p className="error">{err}</p>}
        </>
      )}
    </div>
  );
}

// …-p1/-p2 dosyaları tek satırda topla (ana sayfadaki davranışın lokali)
function groupLocalParts(list: LocalMatchMeta[]) {
  type G = { head: LocalMatchMeta; parts: LocalMatchMeta[]; scoreA: number; scoreB: number };
  const out: G[] = [];
  const byBase = new Map<string, G>();
  for (const m of list) {
    const [sa, sb] = scoreOf(m.detail);
    const pm = /^(.*)-p(\d)$/.exec(m.name ?? '');
    if (!pm) {
      out.push({ head: m, parts: [m], scoreA: sa, scoreB: sb });
      continue;
    }
    const g = byBase.get(pm[1]);
    if (!g) {
      const ng = { head: m, parts: [m], scoreA: sa, scoreB: sb };
      byBase.set(pm[1], ng);
      out.push(ng);
    } else {
      g.parts.push(m);
      g.scoreA += sa; g.scoreB += sb;
      if (Number(pm[2]) === 1) g.head = m; // link ilk parçaya
      g.parts.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    }
  }
  return out;
}
