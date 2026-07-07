import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, type MapBase } from '../lib/mapbase';
import { paintHeat } from '../lib/heatpaint';
import { teamHue } from '../lib/rounds';
import { MlMark } from '../lib/MlMark';

// Oyuncu sayfası: roller (kanıtlı), harita performansı, açılış düelloları,
// arşiv ısı haritaları ve anomali bayrakları.
const MAPW = 400;

export default function Player() {
  const { playerId = '' } = useParams();
  const prof = useQuery({
    queryKey: ['playerProfile', playerId],
    queryFn: () => api.playerProfile(playerId),
  });

  const [mapSel, setMapSel] = useState('');
  if (prof.isLoading || !prof.data) return <p className="meta">loading…</p>;
  const d = prof.data;
  const openByMap = new Map(d.openings.map((o) => [o.map_name, o]));
  // harita = sayfanın ana ekseni: '' = tüm haritalar (genel profil)
  const mapList = d.maps.map((m) => m.map_name);
  const roleRows = d.roles.filter((r) => (r.map_name ?? '') === mapSel);

  return (
    <>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="monogram lg" style={{ background: `hsl(${teamHue(d.nickname)},45%,32%)` }}>
          {d.nickname.slice(0, 2).toUpperCase()}
        </span>
        {d.nickname}
        {d.team && <span className="meta">({d.team})</span>}
      </h1>
      <div className="toolbar">
        <span className="meta">map:</span>
        <button className={mapSel === '' ? '' : 'ghost'} onClick={() => setMapSel('')}>all maps</button>
        {mapList.map((m) => (
          <button key={m} className={mapSel === m ? '' : 'ghost'} onClick={() => setMapSel(m)}>
            {m.replace('de_', '')}
          </button>
        ))}
      </div>

      {/* Roller: seçili harita için taraf başına kart (map_name='' = genel) */}
      <div className="grid cards two">
        {roleRows.length === 0 && (
          <p className="meta">no role data on this map yet (needs 30+ rounds per side)</p>
        )}
        {roleRows.map((r) => (
          <div key={r.side + r.map_name} className="card">
            <div className="teams">
              <span>
                <span className={`badge ${r.side}`}>{r.side}</span>{' '}
                {mapSel && <span className="badge gray">{mapSel.replace('de_', '')}</span>}{' '}
                <MlMark note="Role tags come from the ML pipeline: position, timing and inventory metrics with open thresholds — evidence is shown right here." />{' '}
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
                {(() => {
                  const tm = d.trades.find((t) => t.side === r.side);
                  const dt = d.deaths_traded.find((t) => t.side === r.side);
                  if (!tm && !dt) return null;
                  return (
                    <tr>
                      <td className="meta">trades made</td>
                      <td>{tm?.made ?? 0}</td>
                      <td className="meta">deaths traded</td>
                      <td>
                        {dt && dt.deaths
                          ? `${Math.round((100 * dt.traded) / dt.deaths)}% (${dt.traded}/${dt.deaths})`
                          : '—'}
                      </td>
                    </tr>
                  );
                })()}
                {(() => {
                  const fl = d.flash.find((f) => f.side === r.side);
                  if (!fl || !fl.thrown) return null;
                  return (
                    <tr>
                      <td className="meta">flashes</td>
                      <td>{fl.thrown} thrown</td>
                      <td className="meta">blinded</td>
                      <td>
                        {(fl.enemies / fl.thrown).toFixed(2)}/flash
                        {fl.avg_blind != null && <span className="meta"> · {fl.avg_blind}s avg</span>}
                      </td>
                    </tr>
                  );
                })()}
                {(() => {
                  const ud = d.util_dmg.find((x) => x.side === r.side);
                  if (!ud || (ud.he_n === 0 && ud.fire_n === 0) || (ud.he_dmg + ud.fire_dmg === 0)) return null;
                  return (
                    <tr>
                      <td className="meta">util dmg</td>
                      <td>{ud.he_n ? `HE ${(ud.he_dmg / ud.he_n).toFixed(1)}/nade` : '—'}</td>
                      <td className="meta">fire</td>
                      <td>{ud.fire_n ? `${(ud.fire_dmg / ud.fire_n).toFixed(1)}/nade` : '—'}</td>
                    </tr>
                  );
                })()}
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
              <tr
                key={m.map_name}
                onClick={() => setMapSel(m.map_name === mapSel ? '' : m.map_name)}
                style={{ cursor: 'pointer',
                  background: m.map_name === mapSel ? 'rgba(76,143,82,.15)' : undefined }}
                title="click to focus the whole page on this map"
              >
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

      {/* Clutch'lar */}
      {d.clutches.length > 0 && (
        <>
          <h2>Clutches <span className="meta">(1vX situations, first per round)</span></h2>
          <div className="grid cards two">
            <div className="card">
              <table>
                <thead><tr><th>Situation</th><th>Won</th><th>Rate</th></tr></thead>
                <tbody>
                  {d.clutches.map((c) => (
                    <tr key={c.versus}>
                      <td>1v{c.versus}</td>
                      <td>{c.wins}/{c.attempts}</td>
                      <td>{Math.round((100 * c.wins) / c.attempts)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="meta" style={{ marginBottom: 6 }}>
                notable moments — multi-kills first, then clutches (wins on top)
              </div>
              {(d.big_rounds ?? [])
                .filter((m) => !mapSel || m.map_name === mapSel)
                .slice(0, 5).map((m, i) => (
                <div key={'bk' + i} style={{ marginBottom: 3 }}>
                  <Link to={`/match/${m.match_id}?round=${m.round_number}`}>
                    ▶ 💥 {m.kills}k round — {m.map_name} r{m.round_number}
                  </Link>
                  <span className="meta"> <span className={`badge ${m.side}`}>{m.side}</span> {m.played_at}</span>
                </div>
              ))}
              {d.clutch_moments
                .filter((m) => !mapSel || m.map_name === mapSel)
                .slice(0, 8).map((m, i) => (
                <div key={i} style={{ marginBottom: 3 }}>
                  <Link to={`/match/${m.match_id}?round=${m.round_number}`}>
                    ▶ 1v{m.versus} {m.won ? '✅' : '❌'} — {m.map_name} r{m.round_number}
                  </Link>
                  <span className="meta"> at {Math.round(m.start_sec)}s</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Isı haritaları — sayfa haritasıyla senkron başlar */}
      <PlayerHeat key={mapSel} playerId={playerId} maps={mapList} initial={mapSel} />

      {/* Anomaliler */}
      {d.flags.length > 0 && (
        <>
          <h2>Anomaly flags <MlMark note="ML pipeline: each metric is compared to the player's own historical baseline; |z| measures how unusual the match was." /> <span className="meta">(|z| &gt; 1.5 vs own baseline) — unusual matches, good or bad, not accusations</span></h2>
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

function PlayerHeat({ playerId, maps, initial = '' }: { playerId: string; maps: string[]; initial?: string }) {
  const [mapName, setMapName] = useState(initial);
  const [wnd, setWnd] = useState<'0-115' | '0-25'>('0-115');
  const [awp, setAwp] = useState(false);
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
          <button className={awp ? '' : 'ghost'} onClick={() => setAwp(!awp)}
            title="only positions taken while carrying an AWP — where do they set up with the big gun?">
            🎯 AWP only
          </button>
        </span>
      </h2>
      <div className="grid cards two">
        {(['T', 'CT'] as const).map((side) => (
          <HeatCard key={side + effMap + wnd + awp} playerId={playerId} mapName={effMap} side={side} t0={t0} t1={t1} awp={awp} />
        ))}
      </div>
    </>
  );
}

function HeatCard({
  playerId, mapName, side, t0, t1, awp = false,
}: {
  playerId: string; mapName: string; side: 'T' | 'CT'; t0: number; t1: number; awp?: boolean;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);
  const heat = useQuery({
    queryKey: ['playerHeat', playerId, mapName, side, t0, t1, awp],
    queryFn: () => api.playerHeatmap(playerId, new URLSearchParams({
      map: mapName, side, t0: String(t0), t1: String(t1),
      ...(awp ? { awp: '1' } : {}),
    })),
  });
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
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
