import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRoster, useWindow, WindowPicker } from '../lib/window';
import { api, type ReportResp, type StackResp } from '../api';
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
          title="won the pistol AND the following (2nd/14th) round — holding the anti-eco"
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

      {/* 3b — Execute templates */}
      {d.exec_templates.length > 0 && (
        <>
          <h2>Execute templates <span className="meta">(recurring first-25s utility sets{d.archive_wide ? ' · full archive' : ''})</span></h2>
          <div className="card" style={{ maxWidth: 760 }}>
            {d.exec_templates.map((t, i) => {
              const sites = Object.entries(t.site_mix).sort((a, b) => b[1] - a[1]);
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.8 }}>
                  <span>{t.pattern.join(' + ')}</span>
                  <span className="meta" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                    ×{t.n} · {Math.round(100 * t.wins / t.n)}% W · → {sites.map(([s2, n2]) => `${s2} ${n2}`).join(', ')}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

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

      {/* 3b — Sonraki raunt tahmini (ML Lab'in kalibre dağılımı, raporda) */}
      <PredictionSection teamId={teamId} mapName={mapName} />

      {/* 4 — Setups */}
      <h2>Default setups <span className="meta">(positions 15 s into the round)</span>{d.archive_wide && <span className="meta"> · full archive (window n/a)</span>}</h2>
      <div className="grid cards">
        {(['CT', 'T'] as const).map((side) => (
          <SetupCard key={side} d={d} side={side} mapName={mapName} />
        ))}
      </div>

      {/* 5 — Utility */}
      {d.util_dmg.some((u) => u.he_n + u.fire_n > 0) && (
        <div className="card" style={{ maxWidth: 560, marginBottom: 10 }}>
          <div className="teams"><span>Utility damage</span>
            <span className="meta">avg per grenade (needs reprocessed demos)</span></div>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th /><th>HE dmg/nade</th><th>fire dmg/nade</th></tr></thead>
            <tbody>
              {d.util_dmg.map((u) => (
                <tr key={u.side}>
                  <td><span className={`badge ${u.side}`}>{u.side}</span></td>
                  <td>{u.he_n ? (u.he_dmg / u.he_n).toFixed(1) : '—'} <span className="meta">(n={u.he_n})</span></td>
                  <td>{u.fire_n ? (u.fire_dmg / u.fire_n).toFixed(1) : '—'} <span className="meta">(n={u.fire_n})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

      {/* 6 — Positioning heatmaps (kullanıcı seçimli pencere + hizalama) */}
      <PositioningSection teamId={teamId} mapName={mapName} windowNote={d.window_since} />

      {/* 6.4 — Raunt bindirmesi: tüm maçlarda aynı raunt, ghost izleri */}
      <RoundOverlay teamId={teamId} mapName={mapName} />

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
          {[...d.players]
            .sort((a, b) => a.nickname.localeCompare(b.nickname) || a.side.localeCompare(b.side))
            .map((p, i, arr) => (
            <tr key={p.player_id + p.side}>
              <td style={{ fontWeight: 600 }}>
                {i > 0 && arr[i - 1].nickname === p.nickname
                  ? <span className="meta" style={{ paddingLeft: 8 }}>〃</span>
                  : <Link to={`/player/${p.player_id}`}>{p.nickname}</Link>}
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

function Stat({ label, v, n, title }: { label: string; v: string; n: string; title?: string }) {
  return (
    <div className="card" title={title}>
      <div className="meta">{label}{title ? ' ⓘ' : ''}</div>
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

// Sonraki raunt tahmini: /predict'in kalibre dağılımı rapor bağlamında.
// ML Lab'deki laboratuvarın rapora gömülü hâli — yöntem + kanıt notu aynen
// gösterilir (ürün etiği: her tahminin yanında kanıt gücü).
const PREDICT_METHOD_LABEL: Record<string, string> = {
  league: 'league baseline', team: 'team tendency', team_buy: 'team + economy',
  team_vs: 'head-to-head', team_style: 'opponent style', lgbm: 'LightGBM model',
};

function PredictionSection({ teamId, mapName }: { teamId: string; mapName: string }) {
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const [buy, setBuy] = useState('full');
  const [oppId, setOppId] = useState('');
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.teams() });
  const opps = (teams.data ?? [])
    .filter((t) => t.matches > 0 && t.team_id !== teamId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const predict = useQuery({
    queryKey: ['predict', teamId, oppId, mapName, side, buy],
    queryFn: () => {
      const p = new URLSearchParams({ team_id: teamId, map: mapName, side });
      if (buy) p.set('buy_type', buy);
      if (oppId) p.set('opp_id', oppId);
      return api.predict(p);
    },
    enabled: !!teamId && !!mapName,
  });
  return (
    <>
      <h2>
        Next-round prediction{' '}
        <span className="meta">— what will they most likely run? (from the ML Lab, evidence included)</span>
      </h2>
      <div className="panel">
        <div className="toolbar noprint">
          {(['T', 'CT'] as const).map((s) => (
            <button key={s} className={side === s ? '' : 'ghost'} onClick={() => setSide(s)}>{s}</button>
          ))}
          <select value={buy} onChange={(e) => setBuy(e.target.value)}>
            <option value="">buy unknown</option>
            {['pistol', 'eco', 'semi', 'force', 'full'].map((b) => <option key={b}>{b}</option>)}
          </select>
          <span className="meta">vs</span>
          <select value={oppId} onChange={(e) => setOppId(e.target.value)}>
            <option value="">any opponent</option>
            {opps.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
          </select>
        </div>
        {predict.data && (
          <>
            <div className="toolbar" style={{ gap: 8 }}>
              <span className="badge gray">
                method: {PREDICT_METHOD_LABEL[predict.data.method] ?? predict.data.method}
              </span>
              <span className="meta">{predict.data.evidence.note}</span>
            </div>
            {(predict.data.clusters ?? []).slice(0, 5).map((c) => (
              <div key={c.cluster_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <div style={{ flex: '0 0 42px', fontVariantNumeric: 'tabular-nums' }}>
                  %{Math.round(100 * c.prob)}
                </div>
                <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 9 }}>
                  <div style={{ width: `${100 * c.prob}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
                </div>
                <div className="meta" style={{ flex: '0 0 55%' }}>
                  {c.label ?? c.top_places.slice(0, 3).map((p) => p.place).join(' → ')}
                </div>
              </div>
            ))}
            <p className="meta noprint" style={{ marginTop: 8 }}>
              methods compete on a temporal test; only the winner is served —
              details in the <Link to="/insights">ML Lab</Link>.
            </p>
          </>
        )}
      </div>
    </>
  );
}

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

function PositioningSection({ teamId, mapName, windowNote }: {
  teamId: string; mapName: string; windowNote?: string;
}) {
  const [anchor, setAnchor] = useState<'start' | 'plant'>('start');
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(25);
  return (
    <>
      <h2>
        Positioning <span className="meta">({windowNote ? `rounds since ${windowNote}` : 'all archived rounds'})</span>
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10, gap: 6 }}>
          <select value={anchor} onChange={(e) => setAnchor(e.target.value as 'start' | 'plant')}>
            <option value="start">from round start</option>
            <option value="plant">after bomb plant</option>
          </select>
          <input type="number" min={0} max={110} style={{ width: 54 }} value={t0}
            onChange={(e) => setT0(Math.max(0, Number(e.target.value)))} />
          <span className="meta">→</span>
          <input type="number" min={1} max={115} style={{ width: 54 }} value={t1}
            onChange={(e) => setT1(Math.max(1, Number(e.target.value)))} />
          <span className="meta">s</span>
        </span>
      </h2>
      <div className="grid cards heatgrid">
        {(['T', 'CT'] as const).map((side) => (
          <TeamHeat
            key={side + anchor + t0 + '-' + t1}
            teamId={teamId} mapName={mapName} side={side}
            t0={t0} t1={Math.max(t0 + 1, t1)} anchor={anchor}
            tag={`${anchor === 'plant' ? 'post-plant ' : ''}${t0}-${Math.max(t0 + 1, t1)} s`}
          />
        ))}
      </div>
    </>
  );
}

function TeamHeat({
  teamId, mapName, side, t0, t1, tag, anchor = 'start',
}: {
  teamId: string; mapName: string; side: 'T' | 'CT'; t0: number; t1: number; tag: string;
  anchor?: 'start' | 'plant';
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);
  const [, since] = useWindow();
  const [roster] = useRoster();
  const heat = useQuery({
    queryKey: ['teamHeat', teamId, mapName, side, t0, t1, since, roster, anchor],
    queryFn: () => api.teamHeatmap(teamId, new URLSearchParams({
      map: mapName, side, t0: String(t0), t1: String(t1), since,
      roster_min: String(roster), anchor,
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


// Takım raporu raunt-bindirmesi: seçilen TEK raunt numarası, takımın o
// haritadaki tüm maçlarından (pencere/kadro filtresi dahil, en yeni 30)
// üst üste oynatılır — taraf her rauntta takımın kendi tarafıdır.
function RoundOverlay({ teamId, mapName }: { teamId: string; mapName: string }) {
  const [, since] = useWindow();
  const [roster] = useRoster();
  const [roundNo, setRoundNo] = useState(1);
  const [align, setAlign] = useState('round_start');
  const [mode, setMode] = useState<'ghost' | 'heat'>('ghost');
  const [t, setT] = useState(30);
  const [data, setData] = useState<StackResp | null>(null);
  const [busy, setBusy] = useState(false);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);

  async function load() {
    setBusy(true);
    try {
      const ms = (await api.matches(teamId, since, roster))
        .filter((m) => m.map_name === mapName && m.status === 'ready')
        .slice(0, 30);
      const resp = await api.stack({
        rounds: ms.map((m) => ({ match_id: m.match_id, round_number: roundNo })),
        align, team_id: teamId,
      });
      setData(resp);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    if (!data) return;
    const layers = data.layers.filter((l: StackResp['layers'][number]) => !l.skipped && l.players?.length);
    if (mode === 'heat') {
      const cells = new Map<string, number>();
      for (const ly of layers) {
        for (const p of ly.players ?? []) {
          for (let i = 0; i < p.t.length; i++) {
            if (p.t[i] < 0 || p.t[i] > t) continue;
            const key = `${Math.floor(p.rx[i] / 8)}:${Math.floor(p.ry[i] / 8)}`;
            cells.set(key, (cells.get(key) ?? 0) + 1);
          }
        }
      }
      paintHeat(ctx, MAPW, base, {
        cells: [...cells.entries()].map(([k, w]) => {
          const [cx, cy] = k.split(':').map(Number);
          return [cx, cy, w] as [number, number, number];
        }),
        cell_radar: 8, radar: data.radar,
      });
      return;
    }
    layers.forEach((ly: StackResp['layers'][number], li: number) => {
      const hue = Math.round((li * 137.508) % 360);
      ctx.strokeStyle = `hsla(${hue},70%,60%,0.5)`;
      ctx.lineWidth = 1.2;
      for (const p of ly.players ?? []) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < p.t.length; i++) {
          if (p.t[i] < 0 || p.t[i] > t) continue;
          const x = (p.rx[i] * MAPW) / RADAR, y = (p.ry[i] * MAPW) / RADAR;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // uç nokta
        for (let i = p.t.length - 1; i >= 0; i--) {
          if (p.t[i] <= t && p.t[i] >= 0) {
            const x = (p.rx[i] * MAPW) / RADAR, y = (p.ry[i] * MAPW) / RADAR;
            ctx.fillStyle = `hsl(${hue},70%,60%)`;
            ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
            break;
          }
        }
      }
    });
  }, [base, data, t, mode]);

  const n = data ? data.layers.filter((l: StackResp['layers'][number]) => !l.skipped).length : 0;
  return (
    <>
      <h2>
        Round overlay <span className="meta">(same round across every match{n ? ` · ${n} rounds` : ''})</span>
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10, gap: 6 }}>
          <label className="meta">round</label>
          <input type="number" min={1} max={40} style={{ width: 52 }} value={roundNo}
            onChange={(e) => setRoundNo(Math.max(1, Number(e.target.value)))} />
          <select value={align} onChange={(e) => setAlign(e.target.value)}>
            <option value="round_start">align: round start</option>
            <option value="bomb_plant">align: bomb plant</option>
            <option value="first_kill">align: first kill</option>
          </select>
          <button className={mode === 'ghost' ? '' : 'ghost'} onClick={() => setMode('ghost')}>trails</button>
          <button className={mode === 'heat' ? '' : 'ghost'} onClick={() => setMode('heat')}>heat</button>
          <button onClick={load} disabled={busy}>{busy ? '…' : 'load'}</button>
        </span>
      </h2>
      {data && (
        <div className="card" style={{ maxWidth: 560 }}>
          <canvas ref={cvRef} style={{ width: '100%' }} />
          <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input type="range" min={align === 'round_start' ? 0 : -10} max={60} value={t} style={{ flex: 1 }}
              onChange={(e) => setT(Number(e.target.value))} />
            <span className="meta" style={{ width: 46, fontVariantNumeric: 'tabular-nums' }}>{t}s</span>
          </div>
          <p className="meta">
            each color = one match's round {roundNo}; drag the slider to sweep time.
            Pistols: round 1/13 · post-plant reads: align at bomb plant.
          </p>
        </div>
      )}
      {!data && <p className="meta">pick a round number and load — e.g. round 1 shows every pistol at once.</p>}
    </>
  );
}
