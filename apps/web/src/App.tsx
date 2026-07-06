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
import LocalReportPage from './pages/LocalReport';

// ?admin=TOKEN ile bir kez tanıtılır; sonrasında admin panelleri görünür
// ve istekler X-Admin-Token başlığı taşır.
const adminParam = new URLSearchParams(window.location.search).get('admin');
if (adminParam) {
  localStorage.setItem('tm_admin', adminParam);
  const u = new URL(window.location.href);
  u.searchParams.delete('admin');
  window.history.replaceState(null, '', u.toString());
}

export default function App() {
  return (
    <>
      <nav>
        <span className="brand" style={{ cursor: 'pointer' }} onClick={() => (window.location.href = '/')}>
          Freezetime
        </span>
        <SearchBar />
        <a href="/moments" style={{ whiteSpace: 'nowrap' }}>🔎 Moments</a>
        <a href="/compare" style={{ whiteSpace: 'nowrap' }}>⚔ Compare</a>
        <a href="/leaderboards" style={{ whiteSpace: 'nowrap' }}>🏆 Boards</a>
        <a href="/playlists" style={{ whiteSpace: 'nowrap' }}>🎬 Playlists</a>
        <a href="/analyze" style={{ whiteSpace: 'nowrap' }}>⚡ Analyze</a>
        <a href="/insights" style={{ whiteSpace: 'nowrap' }}>🧠 ML Lab</a>
        <a href="/mydb" style={{ whiteSpace: 'nowrap' }}>🗄 Create DB</a>
        {localStorage.getItem('tm_admin') && (
          <a href="/upload" style={{ whiteSpace: 'nowrap' }}>⬆ Upload</a>
        )}
        <a href="/help" style={{ whiteSpace: 'nowrap' }}>? Help</a>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/match/:id" element={<MatchPage />} />
          <Route path="/match/:id/round/:n" element={<OldRoundRedirect />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/yukle" element={<Upload />} />
          <Route path="/report/:teamId" element={<Report />} />
          <Route path="/team/:teamId" element={<Team />} />
          <Route path="/moments" element={<Moments />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/player/:playerId" element={<Player />} />
          <Route path="/help" element={<Help />} />
          <Route path="/leaderboards" element={<Leaderboards />} />
          <Route path="/playlists" element={<Playlists />} />
          <Route path="/analyze" element={<Analyze />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/mydb" element={<MyDb />} />
          <Route path="/mydb/report" element={<LocalReportPage />} />
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
