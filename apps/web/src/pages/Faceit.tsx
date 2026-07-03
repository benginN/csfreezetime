import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

// FACEIT oyuncu profili: nickname → elo/seviye, ömürlük istatistik,
// harita segmentleri, son maçlar (W/L). Her maç import edilebilir
// (Downloads onayı gerektirir; onaysızsa hata satırda görünür).
interface FaceitProfile {
  player_id: string;
  nickname: string;
  avatar: string;
  country: string;
  elo: number;
  level: number;
  region: string;
  lifetime: Record<string, unknown> | null;
  maps: { map: string; stats: Record<string, string> }[];
  matches: {
    match_id: string; started_at: string; label: string;
    score: string; won: boolean; competition: string;
  }[];
}

export default function Faceit() {
  const { nick = '' } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(nick);

  const prof = useQuery({
    queryKey: ['faceitPlayer', nick],
    queryFn: async (): Promise<FaceitProfile> => {
      const r = await fetch(`/api/v1/faceit/player?nickname=${encodeURIComponent(nick)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j;
    },
    enabled: !!nick,
    retry: false,
  });

  return (
    <>
      <h1>FACEIT lookup</h1>
      <div className="toolbar">
        <input
          style={{ width: 220 }}
          placeholder="FACEIT nickname…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && input.trim() && nav(`/faceit/${encodeURIComponent(input.trim())}`)}
        />
        <button disabled={!input.trim()} onClick={() => nav(`/faceit/${encodeURIComponent(input.trim())}`)}>
          Look up
        </button>
      </div>

      {prof.isLoading && <p className="meta">loading profile…</p>}
      {prof.error && <p className="error">{String(prof.error)}</p>}
      {prof.data && <Profile d={prof.data} />}
    </>
  );
}

const life = (d: FaceitProfile, key: string): string =>
  d.lifetime && d.lifetime[key] != null ? String(d.lifetime[key]) : '—';

function Profile({ d }: { d: FaceitProfile }) {
  return (
    <>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {d.avatar && (
          <img src={d.avatar} alt="" style={{ width: 52, height: 52, borderRadius: 11 }} />
        )}
        {d.nickname}
        <span className="badge gray">level {d.level}</span>
        <span className="badge gray">{d.elo} elo</span>
        <span className="meta">{d.country?.toUpperCase()} · {d.region}</span>
      </h1>

      <div className="grid cards statgrid">
        <Stat label="Matches" v={life(d, 'Matches')} />
        <Stat label="Win rate" v={`${life(d, 'Win Rate %')}%`} />
        <Stat label="Avg K/D" v={life(d, 'Average K/D Ratio')} />
        <Stat label="Avg HS" v={`${life(d, 'Average Headshots %')}%`} />
        <Stat label="Recent" v={
          Array.isArray(d.lifetime?.['Recent Results'])
            ? (d.lifetime!['Recent Results'] as string[]).map((x) => (x === '1' ? 'W' : 'L')).join(' ')
            : '—'
        } />
      </div>

      {d.maps.length > 0 && (
        <>
          <h2>Maps <span className="meta">(FACEIT lifetime)</span></h2>
          <table style={{ maxWidth: 720 }}>
            <thead>
              <tr><th>Map</th><th>Matches</th><th>Win rate</th><th>Avg K/D</th><th>Avg kills</th></tr>
            </thead>
            <tbody>
              {d.maps
                .filter((m) => Number(m.stats['Matches'] ?? 0) > 0)
                .sort((a, b) => Number(b.stats['Matches']) - Number(a.stats['Matches']))
                .map((m) => (
                  <tr key={m.map}>
                    <td>{m.map}</td>
                    <td>{m.stats['Matches'] ?? '—'}</td>
                    <td>{m.stats['Win Rate %'] ?? '—'}%</td>
                    <td>{m.stats['Average K/D Ratio'] ?? '—'}</td>
                    <td>{m.stats['Average Kills'] ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Recent matches <span className="meta">(import runs the full analysis)</span></h2>
      <table style={{ maxWidth: 820 }}>
        <thead>
          <tr><th /><th>Match</th><th>Score</th><th>Competition</th><th>Date</th><th /></tr>
        </thead>
        <tbody>
          {d.matches.map((m) => <MatchRow key={m.match_id} m={m} />)}
        </tbody>
      </table>
    </>
  );
}

function MatchRow({ m }: { m: FaceitProfile['matches'][number] }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'err'>('idle');
  const [msg, setMsg] = useState('');
  const [matchId, setMatchId] = useState('');

  async function doImport() {
    setState('busy');
    setMsg('');
    try {
      const r = await fetch('/api/v1/faceit/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match: m.match_id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMatchId(j.match_id);
      setState('done');
    } catch (e) {
      setMsg(String(e));
      setState('err');
    }
  }

  return (
    <>
      <tr>
        <td style={{ color: m.won ? '#7fd88f' : '#e05545', fontWeight: 700 }}>
          {m.won ? 'W' : 'L'}
        </td>
        <td>{m.label}</td>
        <td>{m.score}</td>
        <td className="meta cut">{m.competition}</td>
        <td className="meta">{m.started_at}</td>
        <td>
          {state === 'done'
            ? <Link to={`/match/${matchId}`}>▶ open</Link>
            : (
              <button className="ghost" disabled={state === 'busy'} onClick={doImport}>
                {state === 'busy' ? 'importing…' : 'import'}
              </button>
            )}
        </td>
      </tr>
      {state === 'err' && (
        <tr><td colSpan={6} className="error" style={{ fontSize: 11.5 }}>{msg}</td></tr>
      )}
    </>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="card">
      <div className="meta">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#b6e2b6' }}>{v}</div>
    </div>
  );
}
