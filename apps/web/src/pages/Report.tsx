import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRoster, useWindow, WindowPicker } from '../lib/window';
import { api, type ReportResp } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';
import { paintHeat } from '../lib/heatpaint';

// Rakip Hazırlık Raporu (Faz 5): koçun maç öncesi tek sayfası.
// Her iddia örneklem boyutuyla; yazdırılabilir (Print düğmesi + @media print).
const MAPW = 430;

export default function Report() {
  const { teamId = '' } = useParams();
  const [params, setParams] = useSearchParams();

  const matches = useQuery({
    queryKey: ['search', ''],
    queryFn: () => api.search(''),
  });
  const teamMatches = (matches.data?.matches ?? []).filter(
    (m) => m.team_a && m.team_b, // isimli maçlar
  );
  const teamName = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.teams(),
    select: (ts) => ts.find((t) => t.team_id === teamId)?.name ?? '',
  });
  const maps = useMemo(() => {
    const s = new Set<string>();
    for (const m of teamMatches) {
      if (m.map_name && (m.team_a === teamName.data || m.team_b === teamName.data)) s.add(m.map_name);
    }
    return [...s].sort();
  }, [teamMatches, teamName.data]);

  const mapName = params.get('map') || maps[0] || '';
  const [win, since, setWin] = useWindow();
  const [roster, setRoster] = useRoster();
  const rep = useQuery({
    queryKey: ['report', teamId, mapName, since, roster],
    queryFn: () => api.report(teamId, mapName, since, roster),
    enabled: !!mapName,
  });

  if (!mapName && matches.isSuccess) return <p className="meta">No maps found for this team.</p>;
  if (rep.isLoading || !rep.data) return <p className="meta">building report…</p>;
  const d = rep.data;
  const ov = d.overview;

  return (
    <div className="report">
      <div className="toolbar noprint">
        <select
          value={mapName}
          onChange={(e) => {
            const p = new URLSearchParams(params);
            p.set('map', e.target.value);
            setParams(p, { replace: true });
          }}
        >
          {maps.map((m) => <option key={m}>{m}</option>)}
        </select>
        <WindowPicker win={win} onChange={setWin} roster={roster} onRoster={setRoster} />
        <button onClick={() => window.print()}>🖨 Print</button>
        {d.insufficient && (
          <span className="error">small sample — treat every number with caution</span>
        )}
      </div>

      <h1>
        Opponent report: {d.team} <span className="meta">on {d.map} · {ov.matches} matches{d.window_since ? ` since ${d.window_since}` : ' in archive'}</span>
      </h1>

      {/* 1 — Overview */}
      <div className="grid cards statgrid">
        <Stat label="Map record" v={`${ov.wins}–${ov.matches - ov.wins}`} n={`${ov.matches} matches`} />
        <Stat label="T round win" v={pct(ov.t_wins, ov.t_rounds)} n={`${ov.t_wins}/${ov.t_rounds}`} />
        <Stat label="CT round win" v={pct(ov.ct_wins, ov.ct_rounds)} n={`${ov.ct_wins}/${ov.ct_rounds}`} />
        <Stat label="Pistol rounds" v={pct(ov.pistol_wins, ov.pistol_rounds)} n={`${ov.pistol_wins}/${ov.pistol_rounds}`} />
        <Stat
          label="Convert after pistol win"
          v={ov.conv_after_pistol_win_n ? `${Math.round(100 * ov.conv_after_pistol_win)}%` : '—'}
          n={`n=${ov.conv_after_pistol_win_n}`}
        />
      </div>

      {/* 2 — Economy */}
      <RecentResults teamId={teamId} mapName={d.map} since={since} roster={roster} />

      <h2>Economy behaviour <span className="meta">(rounds 2-12 / 14-24)</span></h2>
      <div className="grid cards">
        <BuyCard title="T buys" dist={d.economy.buy_T} />
        <BuyCard title="CT buys" dist={d.economy.buy_CT} />
        <BuyCard title="After losing a pistol" dist={d.economy.after_pistol_loss} />
      </div>

      {/* 3 — Strategy tendencies (küme adları koçça düzenlenebilir) */}
      <h2>Strategy tendencies <span className="meta">— ✏ names strategies for everyone</span></h2>
      <div className="grid cards">
        {(['T', 'CT'] as const).map((side) => {
          const rows = d.tendencies.filter((t) => t.side === side).slice(0, 4);
          if (!rows.length) return null;
          return (
            <div key={side} className="card">
              <div className="teams">
                <span><span className={`badge ${side}`}>{side}</span> most likely approaches</span>
                <span className="meta">{rows[0].sample_size} rounds</span>
              </div>
              {rows.map((t) => (
                <NamableBar key={t.cluster_id} t={t} side={side} mapName={mapName} teamId={teamId} />
              ))}
            </div>
          );
        })}
      </div>
      {d.conditional.length > 0 && (
        <>
          <h3>By buy type <span className="meta">(most likely approach given the buy)</span></h3>
          <table className="cond">
            <thead><tr><th>Side</th><th>Buy</th><th>Most likely</th><th>P</th><th>n</th></tr></thead>
            <tbody>
              {d.conditional.map((c, i) => (
                <tr key={i}>
                  <td><span className={`badge ${c.side}`}>{c.side}</span></td>
                  <td>{c.buy_type}</td>
                  <td>{c.label ?? c.top_places.slice(0, 3).map((p) => p.place).join(' → ')}</td>
                  <td>{Math.round(100 * c.prob)}%</td>
                  <td className="meta">{c.sample_size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* 4 — Setups */}
      <h2>Default setups <span className="meta">(positions 15 s into the round)</span>{d.archive_wide && <span className="meta"> · full archive (window n/a)</span>}</h2>
      <div className="grid cards">
        {(['CT', 'T'] as const).map((side) => (
          <SetupCard key={side} d={d} side={side} mapName={mapName} />
        ))}
      </div>

      {/* 5 — Utility */}
      <h2>Utility habits {d.archive_wide && <span className="meta"> · full archive (window n/a)</span>}</h2>
      <UtilitySection d={d} mapName={mapName} />
      <div className="grid cards two" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="teams"><span>Flash → kill sync</span></div>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>Side</th><th>Kills on blind</th><th>Flash→kill</th><th>Good flash converted</th></tr></thead>
            <tbody>
              {d.flash_sync.map((f) => (
                <tr key={f.side}>
                  <td><span className={`badge ${f.side}`}>{f.side}</span></td>
                  <td>{f.blind_kills}/{f.kills} ({f.kills ? Math.round((100 * f.blind_kills) / f.kills) : 0}%)</td>
                  <td>{f.med_gap != null ? `~${f.med_gap.toFixed(1)}s` : '—'}</td>
                  <td>
                    {f.good_flashes
                      ? `${f.converted}/${f.good_flashes} (${Math.round((100 * (f.converted ?? 0)) / f.good_flashes)}%)`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="meta">good flash = blinded at least one enemy; converted = a team kill within 4 s</p>
        </div>
        <div className="card">
          <div className="teams"><span>Trade pairs</span><span className="meta">who avenges whom</span></div>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>Trader</th><th>Avenges</th><th>n</th></tr></thead>
            <tbody>
              {d.trade_pairs.map((t, i) => (
                <tr key={i}><td>{t.trader}</td><td>{t.avenged}</td><td>{t.n}</td></tr>
              ))}
              {!d.trade_pairs.length && <tr><td colSpan={3} className="meta">no recurring pairs (min 2)</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 6 — Positioning heatmaps */}
      <h2>Positioning <span className="meta">({d.window_since ? `rounds since ${d.window_since}` : 'all archived rounds'})</span></h2>
      <div className="grid cards heatgrid">
        {(['T', 'CT'] as const).map((side) => (
          [{ t0: 0, t1: 25, tag: 'first 25 s' }, { t0: 25, t1: 115, tag: 'after 25 s' }].map((wnd) => (
            <TeamHeat key={side + wnd.tag} teamId={teamId} mapName={mapName} side={side} t0={wnd.t0} t1={wnd.t1} tag={wnd.tag} />
          ))
        ))}
      </div>

      {/* 6.5 — Thrown rounds */}
      {d.thrown.length > 0 && (
        <>
          <h2>
            Thrown rounds{' '}
            <span className="meta">(reached ≥75% win probability, still lost — archive win-rate model)</span>
          </h2>
          <table style={{ maxWidth: 560 }}>
            <thead><tr><th>Side</th><th>Peak win prob</th><th>Round</th><th /></tr></thead>
            <tbody>
              {d.thrown.map((t, i) => (
                <tr key={i}>
                  <td><span className={`badge ${t.side}`}>{t.side}</span></td>
                  <td>{Math.round(100 * t.peak)}%</td>
                  <td>r{t.round_number}</td>
                  <td><Link to={`/match/${t.match_id}?round=${t.round_number}`}>▶ watch</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* 7 — Players */}
      <h2>Players {d.archive_wide && <span className="meta"> · full archive (window n/a)</span>}</h2>
      <table>
        <thead>
          <tr>
            <th>Player</th><th>Side</th><th>Roles</th><th>Opening duels</th>
            <th>ADR</th><th>AWP</th><th>Util/r</th><th className="meta">rounds</th>
          </tr>
        </thead>
        <tbody>
          {d.players.map((p, i) => (
            <tr key={i}>
              <td style={{ fontWeight: 600 }}>
                <Link to={`/player/${p.player_id}`}>{p.nickname}</Link>
              </td>
              <td><span className={`badge ${p.side}`}>{p.side}</span></td>
              <td>
                {p.tags.length
                  ? p.tags.map((t) => <span key={t} className="badge gray" style={{ marginRight: 4 }}>{t}</span>)
                  : <span className="meta">—</span>}
              </td>
              <td>
                {p.opening_kills}W–{p.opening_deaths}L
                {p.entry_attempt_share != null && (
                  <span className="meta"> ({Math.round(100 * p.entry_attempt_share)}% of rounds)</span>
                )}
              </td>
              <td>{p.adr != null ? Math.round(p.adr) : '—'}</td>
              <td>{p.awp_round_share != null ? `${Math.round(100 * p.awp_round_share)}%` : '—'}</td>
              <td>{p.util_per_round != null ? p.util_per_round.toFixed(1) : '—'}</td>
              <td className="meta">{p.rounds}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="meta">
        Roles are threshold-based on archive data (labels only past 30 rounds/side).
        ANCHOR share counts positions after the 15-second mark.
      </p>
    </div>
  );
}

function pct(a: number, b: number): string {
  return b ? `${Math.round((100 * a) / b)}%` : '—';
}

function Stat({ label, v, n }: { label: string; v: string; n: string }) {
  return (
    <div className="card">
      <div className="meta">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#b6e2b6' }}>{v}</div>
      <div className="meta">{n}</div>
    </div>
  );
}

// Eğilim çubuğu + inline küme isimlendirme (insan döngüde; ad her yerde görünür)
function NamableBar({
  t, side, mapName, teamId,
}: {
  t: ReportResp['tendencies'][number];
  side: 'T' | 'CT';
  mapName: string;
  teamId: string;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const label = t.label ?? t.top_places.slice(0, 3).map((p) => p.place).join(' → ');

  async function save() {
    await api.renameCluster(mapName, side, t.cluster_id, draft.trim());
    setEditing(false);
    qc.invalidateQueries({ queryKey: ['report', teamId, mapName] }); // tüm pencereler
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }} className="noprint">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          placeholder='e.g. "B rush", "slow A split"'
          style={{ flex: 1 }}
        />
        <button onClick={save}>✓</button>
        <button className="ghost" onClick={() => setEditing(false)}>✕</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ flex: 1 }}><Bar prob={t.prob} label={label} /></div>
      <button
        className="ghost noprint"
        title="name this strategy"
        style={{ padding: '0 5px', fontSize: 11 }}
        onClick={() => { setDraft(t.label ?? ''); setEditing(true); }}
      >
        ✏
      </button>
    </div>
  );
}

function Bar({ prob, label }: { prob: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{ flex: '0 0 42px', fontVariantNumeric: 'tabular-nums' }}>{Math.round(100 * prob)}%</div>
      <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 9 }}>
        <div style={{ width: `${100 * prob}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
      </div>
      <div className="meta" style={{ flex: '0 0 55%' }}>{label}</div>
    </div>
  );
}

function BuyCard({ title, dist }: { title: string; dist: Record<string, number> }) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  const order = ['full', 'force', 'semi', 'eco', 'unknown'];
  return (
    <div className="card">
      <div className="teams"><span>{title}</span><span className="meta">n={total}</span></div>
      {order.filter((k) => dist[k]).map((k) => (
        <Bar key={k} prob={total ? dist[k] / total : 0} label={`${k} (${dist[k]})`} />
      ))}
      {!total && <p className="meta">no data</p>}
    </div>
  );
}

// Radar üstünde kurulum deseni: yerleşim merkezlerine noktalar.
function SetupCard({ d, side, mapName }: { d: ReportResp; side: 'T' | 'CT'; mapName: string }) {
  const setups = d.setups.filter((s) => s.side === side && s.t_offset === 15).slice(0, 3);
  const [sel, setSel] = useState(0);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);

  const cur = setups[Math.min(sel, setups.length - 1)];
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base || !cur) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    const centro = new Map(base.layout.places.map((p) => [p.name, p]));
    for (const pp of cur.pattern) {
      const c = centro.get(pp.place);
      if (!c) continue;
      const x = (c.rx * MAPW) / RADAR, y = (c.ry * MAPW) / RADAR;
      ctx.fillStyle = side === 'T' ? '#e8a33d' : '#4d9de0';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0b0e0c'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = '#0b0e0c'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(pp.n), x, y + 4);
      ctx.fillStyle = '#dbe4dc'; ctx.font = '10px system-ui';
      ctx.fillText(pp.place, x, y - 13);
      ctx.textAlign = 'left';
    }
  }, [base, cur, side]);

  if (!setups.length) {
    return (
      <div className="card">
        <div className="teams"><span><span className={`badge ${side}`}>{side}</span> setups</span></div>
        <p className="meta">not enough rounds for a reliable pattern</p>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="teams">
        <span><span className={`badge ${side}`}>{side}</span> setups</span>
        <span className="meta">{cur.sample_size} rounds</span>
      </div>
      <div className="toolbar" style={{ margin: '6px 0' }}>
        {setups.map((s, i) => (
          <button key={i} className={i === sel ? '' : 'ghost'} onClick={() => setSel(i)}>
            #{i + 1} · {Math.round(100 * s.share)}%
          </button>
        ))}
      </div>
      <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} />
      <p className="meta" style={{ marginTop: 6 }}>
        {cur.pattern.map((p) => `${p.place}×${p.n}`).join(' · ')} — seen {cur.observed}/{cur.sample_size}
        {cur.avg_hold_sec != null && <> · held ≈{Math.round(cur.avg_hold_sec)} s</>}
        {' · '}
        {cur.representatives.slice(0, 2).map((r, i) => (
          <span key={i}>{i > 0 && ', '}<Link to={`/match/${r.match_id}?round=${r.round_number}`}>▶ r{r.round_number}</Link></span>
        ))}
      </p>
      {(() => {
        const rot = d.rotations.filter(
          (x) => x.side === side && x.pattern_id === cur.pattern_id,
        );
        if (!rot.length) return null;
        return (
          <div className="meta" style={{ marginTop: 4 }}>
            after first contact:
            {rot.map((x) => (
              <div key={x.place} style={{ marginLeft: 8 }}>
                <b style={{ color: '#b9c2bb' }}>{x.place}</b> rotates{' '}
                {Math.round(100 * x.rotate_rate)}% (n={x.n_contacts}
                {x.med_delay_sec != null && <>, ~{Math.round(x.med_delay_sec)}s</>})
                {x.dest_mix && Object.keys(x.dest_mix).length > 0 && (
                  <> → {Object.entries(x.dest_mix)
                    .sort((a, b) => b[1] - a[1])
                    .map(([pl, n]) => `${pl}(${n})`).join(', ')}</>
                )}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

const UTIL_CSS: Record<string, string> = {
  smoke: '#b4b9be', molotov: '#eb781e', flash: '#ffffff', he: '#ff8c3c',
};

function UtilitySection({ d, mapName }: { d: ReportResp; mapName: string }) {
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const [type, setType] = useState('smoke');
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);

  const spots = useMemo(
    () => d.utility.filter((u) => u.side === side && u.type === type).slice(0, 10),
    [d.utility, side, type],
  );

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    const maxC = Math.max(1, ...spots.map((s) => s.count));
    for (const sp of spots) {
      const x = (sp.det_rx * MAPW) / RADAR, y = (sp.det_ry * MAPW) / RADAR;
      // atış→varış oku (lineup ipucu)
      if (sp.throw_rx != null && sp.throw_ry != null) {
        const tx = (sp.throw_rx * MAPW) / RADAR, ty = (sp.throw_ry * MAPW) / RADAR;
        ctx.strokeStyle = 'rgba(200,210,200,0.35)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = 5 + 9 * Math.sqrt(sp.count / maxC);
      ctx.fillStyle = UTIL_CSS[type] ?? '#ccc';
      ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0b0e0c';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    }
  }, [base, spots, type]);

  return (
    <div className="grid cards utilgrid">
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
            <option>T</option><option>CT</option>
          </select>
          {['smoke', 'molotov', 'flash', 'he'].map((t) => (
            <button key={t} className={t === type ? '' : 'ghost'} onClick={() => setType(t)}>{t}</button>
          ))}
        </div>
        <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} />
        <p className="meta">dot size = frequency · dashed line = typical throw origin</p>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Spot</th><th>n</th><th>share</th><th>thrown at</th><th /></tr></thead>
          <tbody>
            {spots.map((sp) => (
              <tr key={sp.cluster_id}>
                <td>{sp.label ?? '?'}</td>
                <td>{sp.count}</td>
                <td>{Math.round(100 * sp.share)}%</td>
                <td>
                  {sp.t_avg != null ? `${Math.round(sp.t_avg)}s` : '—'}
                  {sp.t_std != null && <span className="meta"> ±{Math.round(sp.t_std)}</span>}
                </td>
                <td>
                  {sp.representatives.slice(0, 1).map((r, i) => (
                    <Link key={i} to={`/match/${r.match_id}?round=${r.round_number}`}>▶</Link>
                  ))}
                </td>
              </tr>
            ))}
            {!spots.length && <tr><td colSpan={5} className="meta">no recurring spots (min 3 throws per spot)</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamHeat({
  teamId, mapName, side, t0, t1, tag,
}: {
  teamId: string; mapName: string; side: 'T' | 'CT'; t0: number; t1: number; tag: string;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);
  const [, since] = useWindow();
  const [roster] = useRoster();
  const heat = useQuery({
    queryKey: ['teamHeat', teamId, mapName, side, t0, t1, since, roster],
    queryFn: () => api.teamHeatmap(teamId, new URLSearchParams({
      map: mapName, side, t0: String(t0), t1: String(t1), since,
      roster_min: String(roster),
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
        <span><span className={`badge ${side}`}>{side}</span> {tag}</span>
        <span className="meta">{heat.data?.round_count ?? '…'} rounds</span>
      </div>
      <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} style={{ marginTop: 6 }} />
    </div>
  );
}


// Pencere+kadro filtresine uyan geçmiş sonuçlar (rapordaki harita)
function RecentResults({ teamId, mapName, since, roster }: {
  teamId: string; mapName: string; since: string; roster: number;
}) {
  const q = useQuery({
    queryKey: ['teamMatches', teamId, since, roster],
    queryFn: () => api.matches(teamId, since, roster),
  });
  const rows = (q.data ?? []).filter((m) => m.map_name === mapName);
  if (!rows.length) return null;
  return (
    <>
      <h2>Recent results <span className="meta">on {mapName} ({rows.length})</span></h2>
      <table style={{ maxWidth: 760 }}>
        <tbody>
          {rows.map((m) => {
            const isA = m.team_a_id === teamId;
            const us = isA ? m.score_a : m.score_b;
            const them = isA ? m.score_b : m.score_a;
            return (
              <tr key={m.match_id}>
                <td style={{ color: us > them ? '#7fd88f' : '#e05545', fontWeight: 700 }}>
                  {us > them ? 'W' : 'L'}
                </td>
                <td>{us} : {them}</td>
                <td>vs {isA ? m.team_b : m.team_a}</td>
                <td className="meta cut">{m.tournament?.replace(/-/g, ' ')}</td>
                <td className="meta">{m.played_at ?? ''}</td>
                <td><Link to={`/match/${m.match_id}`}>▶</Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
