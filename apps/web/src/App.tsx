import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Home from './pages/Home';
import MatchPage from './pages/MatchPage';
import Upload from './pages/Upload';
import Report from './pages/Report';
import Team from './pages/Team';
import Moments from './pages/Moments';
import Compare from './pages/Compare';
import Player from './pages/Player';
import Help from './pages/Help';
import Leaderboards from './pages/Leaderboards';
import Playlists from './pages/Playlists';
import MyDb from './pages/MyDb';
import Analyze from './pages/Analyze';
import Insights from './pages/Insights';
import Patterns from './pages/Patterns';
import Scenarios from './pages/Scenarios';
import LocalReportPage from './pages/LocalReport';
import StudioOnly from './components/StudioOnly';
import { isStatic } from './lib/staticdata';

// Statik yayında (GitHub Pages) canlı ClickHouse isteyen sayfalar
// StudioOnly notuna düşer; nav'da da gizlenirler.
const studioOnly = (feature: string, el: JSX.Element) =>
  isStatic ? <StudioOnly feature={feature} /> : el;

// ?admin=TOKEN ile bir kez tanıtılır; sonrasında admin panelleri görünür
// ve istekler X-Admin-Token başlığı taşır.
const adminParam = new URLSearchParams(window.location.search).get('admin');
if (adminParam) {
  localStorage.setItem('tm_admin', adminParam);
  const u = new URL(window.location.href);
  u.searchParams.delete('admin');
  window.history.replaceState(null, '', u.toString());
}

// Nav menüsü: tüm sayfalar tek dropdown'da — düz link dizisi dar pencerede
// taşıp son öğeleri (Help/Support) kesiyordu; menü hem sade hem taşmasız.
function NavMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const item = { display: 'block', padding: '9px 16px', whiteSpace: 'nowrap' } as const;
  return (
    <div ref={ref} style={{ position: 'relative', marginLeft: 'auto' }}>
      <button className="ghost" onClick={() => setOpen(!open)} style={{ whiteSpace: 'nowrap' }}>
        ☰ Menu
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 1000,
            background: '#1a201c', border: '1px solid #2c332e', borderRadius: 8,
            minWidth: 190, boxShadow: '0 10px 28px rgba(0,0,0,.55)', padding: '4px 0',
          }}
        >
          {!isStatic && <a href="/moments" style={item}>🔎 Moments</a>}
          <a href="/compare" style={item}>⚔ Compare</a>
          <a href="/leaderboards" style={item}>🏆 Boards</a>
          {!isStatic && <a href="/playlists" style={item}>🎬 Playlists</a>}
          {!isStatic && <a href="/analyze" style={item}>⚡ Analyze</a>}
          <a href="/insights" style={item}>🧠 ML Lab</a>
          {!isStatic && <a href="/patterns" style={item}>🧭 Patterns</a>}
          {!isStatic && <a href="/scenarios" style={item}>🔬 Scenarios</a>}
          {/* Create DB kaldırıldı (2026-07-12): /mydb adresi yaşıyor, Help'te belgeli */}
          {localStorage.getItem('tm_admin') && <a href="/archive" style={item}>🗂 Archive</a>}
          <a href="/help" style={item}>? Help</a>
          <a href="https://ko-fi.com/bengin" target="_blank" rel="noreferrer" style={item}
            title="enjoying Freezetime? support the project">
            ☕ Support
          </a>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <>
      <nav>
        <span className="brand" style={{ cursor: 'pointer' }} onClick={() => (window.location.href = '/')}>
          Freezetime
        </span>
        <SearchBar />
        <NavMenu />
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/match/:id" element={<MatchPage />} />
          <Route path="/match/:id/round/:n" element={<OldRoundRedirect />} />
          <Route path="/archive" element={studioOnly('Archive', <Upload />)} />
          <Route path="/upload" element={<Navigate to="/archive" replace />} />
          <Route path="/yukle" element={<Navigate to="/archive" replace />} />
          <Route path="/report/:teamId" element={<Report />} />
          <Route path="/team/:teamId" element={<Team />} />
          <Route path="/moments" element={studioOnly('Moments — DSL search', <Moments />)} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/player/:playerId" element={<Player />} />
          <Route path="/help" element={<Help />} />
          <Route path="/leaderboards" element={<Leaderboards />} />
          <Route path="/playlists" element={studioOnly('Playlists', <Playlists />)} />
          <Route path="/analyze" element={studioOnly('Analyze a demo', <Analyze />)} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/patterns" element={studioOnly('Pattern Finder', <Patterns />)} />
          <Route path="/scenarios" element={studioOnly('Scenario Lab', <Scenarios />)} />
          <Route path="/mydb" element={studioOnly('Create DB (My DB)', <MyDb />)} />
          <Route path="/mydb/report" element={studioOnly('My DB report', <LocalReportPage />)} />
        </Routes>
      </main>
    </>
  );
}

// Global arama: yazdıkça ana sayfadaki sonuçlar güncellenir (?q=).
// İlk mount'ta navigasyon YAPILMAZ — yoksa maç sayfasına derin link
// 250 ms sonra ana sayfaya sıçrıyordu.
function SearchBar() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const typed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!typed.current) return;
    const t = setTimeout(() => {
      // bayrak zamanlayıcı beklerken düşmüş olabilir (rota değişimi
      // kutuyu programatik boşaltır) — ateşlerken yeniden kontrol et
      if (!typed.current) return;
      nav('/?q=' + encodeURIComponent(text), { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // dışarıdan gelen aramalar (turnuva çipi gibi) kutuya yansısın —
  // yalnız kutu odaklı DEĞİLKEN (yazmayı bölmesin). Bu programatik bir
  // değişimdir: typed bayrağı DÜŞMELİ, yoksa maça tıklayıp q düşünce
  // debounce etkisi kullanıcıyı ana sayfaya geri fırlatır.
  const pq = params.get('q') ?? '';
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      typed.current = false;
      setText(pq);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pq]);

  return (
    <div className="searchbar">
      <span>🔍</span>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => { typed.current = true; setText(e.target.value); }}
        placeholder="Search team, player or map… (e.g. 'spirit g2' for head-to-head)"
      />
      <span className="hint">{text && '↵ instant results'}</span>
    </div>
  );
}

// Eski derin linkler (/match/:id/round/:n) sekmeli maç sayfasına yönlenir.
function OldRoundRedirect() {
  const { id = '', n = '1' } = useParams();
  const [params] = useSearchParams();
  const t = params.get('t');
  return <Navigate to={`/match/${id}?round=${n}${t ? `&t=${t}` : ''}`} replace />;
}
