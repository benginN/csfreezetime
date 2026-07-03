import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, type MapBase } from '../lib/mapbase';
import { paintHeat } from '../lib/heatpaint';
import { teamHue } from '../lib/rounds';

// Oyuncu sayfası: roller (kanıtlı), harita performansı, açılış düelloları,
// arşiv ısı haritaları ve anomali bayrakları.
const MAPW = 400;

export default function Player() {
  const { playerId = '' } = useParams();
  const prof = useQuery({
    queryKey: ['playerProfile', playerId],
    queryFn: () => api.playerProfile(playerId),
  });

  if (prof.isLoading || !prof.data) return <p className="meta">loading…</p>;
  const d = prof.data;
  const openByMap = new Map(d.openings.map((o) => [o.map_name, o]));

  return (
    <>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="monogram lg" style={{ background: `hsl(${teamHue(d.nickname)},45%,32%)` }}>
          {d.nickname.slice(0, 2).toUpperCase()}
        </span>
        {d.nickname}
        {d.team && <span className="meta">({d.team})</span>}
      </h1>

      {/* Roller: taraf başına kart, etiketler kanıt metrikleriyle */}
      <div className="grid cards two">
        {d.roles.map((r) => (
          <div key={r.side} className="card">
            <div className="teams">
              <span>
                <span className={`badge ${r.side}`}>{r.side}</span>{' '}
                {r.tags.length
                  ? r.tags.map((t) => <span key={t} className="badge gray" style={{ marginRight: 4 }}>{t}</span>)
                  : <span className="meta">no role label (threshold-based)</span>}
              </span>
              <span className="meta">{r.rounds} rounds</span>
            </div>
            <table style={{ marginTop: 8 }}>
              <tbody>
                <tr><td className="meta">ADR</td><td>{r.adr != null ? Math.round(r.adr) : '—'}</td>
                    <td className="meta">AWP rounds</td><td>{r.awp_round_share != null ? `${Math.round(100 * r.awp_round_share)}%` : '—'}</td></tr>
                <tr><td className="meta">opening duels</td><td>{r.opening_kills}W–{r.opening_deaths}L</td>
                    <td className="meta">entry share</td><td>{r.entry_attempt_share != null ? `${Math.round(100 * r.entry_attempt_share)}%` : '—'}</td></tr>
                <tr><td className="meta">util / round</td><td>{r.util_per_round?.toFixed(1) ?? '—'}</td>
                    <td className="meta">flash assists/r</td><td>{r.flash_assists_pr?.toFixed(2) ?? '—'}</td></tr>
                {r.side === 'CT' && r.anchor_place && (
                  <tr><td className="meta">anchor</td><td colSpan={3}>{r.anchor_place} ({Math.round(100 * (r.anchor_share ?? 0))}% occupancy)</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* Harita performansı */}
      <h2>Maps</h2>
      <table>
        <thead>
          <tr><th>Map</th><th>Matches</th><th>Rounds</th><th>ADR</th><th>K/D/A</th><th>Openings</th><th>Survival</th></tr>
        </thead>
        <tbody>
          {d.maps.map((m) => {
            const o = openByMap.get(m.map_name);
            return (
              <tr key={m.map_name}>
                <td>{m.map_name}</td>
                <td>{m.matches}</td>
                <td>{m.rounds}</td>
                <td>{m.adr}</td>
                <td>{m.kills}/{m.deaths}/{m.assists}</td>
                <td>{o ? `${o.won}W–${o.lost}L` : '—'}</td>
                <td>{m.survival_pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Isı haritaları */}
      <PlayerHeat playerId={playerId} maps={d.maps.map((m) => m.map_name)} />

      {/* Anomaliler */}
      {d.flags.length > 0 && (
        <>
          <h2>Anomaly flags <span className="meta">(|z| &gt; 1.5 vs own baseline)</span></h2>
          <table>
            <thead><tr><th>Metric</th><th>Value</th><th>Baseline</th><th>z</th><th>Match</th></tr></thead>
            <tbody>
              {d.flags.map((f, i) => (
                <tr key={i}>
                  <td>{f.metric}</td>
                  <td>{f.value.toFixed(1)}</td>
                  <td className="meta">{f.baseline_mean.toFixed(1)} ± {f.baseline_std.toFixed(1)}</td>
                  <td style={{ color: Math.abs(f.z) > 3 ? '#e08585' : undefined }}>{f.z.toFixed(1)}</td>
                  <td><Link to={`/match/${f.match_id}`}>{f.event_name ?? f.map_name}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function PlayerHeat({ playerId, maps }: { playerId: string; maps: string[] }) {
  const [mapName, setMapName] = useState('');
  const [wnd, setWnd] = useState<'0-115' | '0-25'>('0-115');
  const effMap = mapName || maps[0] || '';
  const [t0, t1] = wnd === '0-25' ? [0, 25] : [0, 115];
  if (!effMap) return null;
  return (
    <>
      <h2>
        Positioning{' '}
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10 }}>
          <select value={effMap} onChange={(e) => setMapName(e.target.value)}>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={wnd} onChange={(e) => setWnd(e.target.value as typeof wnd)}>
            <option value="0-115">whole round</option>
            <option value="0-25">first 25 s</option>
          </select>
        </span>
      </h2>
      <div className="grid cards two">
        {(['T', 'CT'] as const).map((side) => (
          <HeatCard key={side + effMap + wnd} playerId={playerId} mapName={effMap} side={side} t0={t0} t1={t1} />
        ))}
      </div>
    </>
  );
}

function HeatCard({
  playerId, mapName, side, t0, t1,
}: {
  playerId: string; mapName: string; side: 'T' | 'CT'; t0: number; t1: number;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);
  const heat = useQuery({
    queryKey: ['playerHeat', playerId, mapName, side, t0, t1],
    queryFn: () => api.playerHeatmap(playerId, new URLSearchParams({
      map: mapName, side, t0: String(t0), t1: String(t1),
    })),
  });
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, true);
    if (heat.data) paintHeat(ctx, MAPW, base, heat.data);
  }, [base, heat.data]);
  return (
    <div className="card">
      <div className="teams">
        <span><span className={`badge ${side}`}>{side}</span></span>
        <span className="meta">{heat.data?.round_count ?? '…'} rounds</span>
      </div>
      <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} style={{ marginTop: 6 }} />
    </div>
  );
}
