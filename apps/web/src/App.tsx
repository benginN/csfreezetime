import { NavLink, Route, Routes } from 'react-router-dom';
import Matches from './pages/Matches';
import MatchDetail from './pages/MatchDetail';
import Replay from './pages/Replay';
import Analysis from './pages/Analysis';

export default function App() {
  return (
    <>
      <nav>
        <span className="brand">TacticalMind</span>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Maçlar
        </NavLink>
        <NavLink to="/analiz" className={({ isActive }) => (isActive ? 'active' : '')}>
          Analiz
        </NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Matches />} />
          <Route path="/match/:id" element={<MatchDetail />} />
          <Route path="/match/:id/round/:n" element={<Replay />} />
          <Route path="/analiz" element={<Analysis />} />
        </Routes>
      </main>
    </>
  );
}
