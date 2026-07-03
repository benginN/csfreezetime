import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Home from './pages/Home';
import MatchPage from './pages/MatchPage';

export default function App() {
  return (
    <>
      <nav>
        <span className="brand" style={{ cursor: 'pointer' }} onClick={() => (window.location.href = '/')}>
          TacticalMind
        </span>
        <SearchBar />
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/match/:id" element={<MatchPage />} />
          <Route path="/match/:id/round/:n" element={<OldRoundRedirect />} />
        </Routes>
      </main>
    </>
  );
}

// Global arama: yazdıkça ana sayfadaki sonuçlar güncellenir (?q=).
function SearchBar() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');

  useEffect(() => {
    const t = setTimeout(() => {
      nav('/?q=' + encodeURIComponent(text), { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="searchbar">
      <span>🔍</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Takım, oyuncu, harita ara… (ör. 'spirit g2' iki takımın maçları)"
      />
      <span className="hint">{text && '↵ sonuçlar anında'}</span>
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
