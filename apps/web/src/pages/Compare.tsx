import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useRoster, useWindow, WindowPicker } from '../lib/window';
import { api, type ReportResp } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';
import { paintHeat } from '../lib/heatpaint';
import { teamHue, teamInitials } from '../lib/rounds';

// Takım karşılaştırma: iki rakip raporu yan yana. Maç hazırlığının
// "biz vs onlar" ekranı — tüm veriler mevcut /report ve /teams/{id}/heatmap
// endpoint'lerinden gelir; her sayı n ile.
const MAPW = 400;

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.teams() });
  const list = (teams.data ?? []).filter((t) => t.matches > 0);
  const [win, since, setWin] = useWindow();
  const [roster, setRoster] = useRoster();

  const sumA = useQuery({
    queryKey: ['teamSummary', a, since, roster], queryFn: () => api.teamSummary(a, since, roster), enabled: !!a,
  });
  const sumB = useQuery({
    queryKey: ['teamSummary', b, since, roster], queryFn: () => api.teamSummary(b, since, roster), enabled: !!b,
  });
  // harita listesi: iki takımın da oynadıkları önce, tek taraflılar işaretli
  const maps = useMemo(() => {
    const ma = new Set((sumA.data?.maps ?? []).map((m) => m.map_name));
    const mb = new Set((sumB.data?.maps ?? []).map((m) => m.map_name));
    const both = [...ma].filter((m) => mb.has(m)).sort();
    const only = [...new Set([...ma, ...mb])].filter((m) => !both.includes(m)).sort();
    return { both, only };
  }, [sumA.data, sumB.data]);
  const mapName = params.get('map') || maps.both[0] || maps.only[0] || '';

  const repA = useQuery({
    queryKey: ['report', a, mapName, since, roster], queryFn: () => api.report(a, mapName, since, roster),
    enabled: !!a && !!mapName,
  });
  const repB = useQuery({
    queryKey: ['report', b, mapName, since, roster], queryFn: () => api.report(b, mapName, since, roster),
    enabled: !!b && !!mapName,
  });

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  return (
    <>
      <h1>Team comparison</h1>
      <div className="toolbar">
        <WindowPicker win={win} onChange={setWin} roster={roster} onRoster={setRoster} />
        <TeamPick label="Team A" value={a} list={list} onPick={(v) => set('a', v)} />
        <span className="meta">vs</span>
        <TeamPick label="Team B" value={b} list={list} onPick={(v) => set('b', v)} />
        {a && b && (
          <select value={mapName} onChange={(e) => set('map', e.target.value)}>
            {maps.both.map((m) => <option key={m} value={m}>{m}</option>)}
            {maps.only.map((m) => <option key={m} value={m}>{m} (one side only)</option>)}
          </select>
        )}
      </div>

      {(!a || !b) && <p className="meta">Pick two teams to compare.</p>}
      {a && b && (repA.isLoading || repB.isLoading) && <p className="meta">building comparison…</p>}
      {repA.data && repB.data && (
        <CompareBody A={repA.data} B={repB.data} mapName={mapName} aId={a} bId={b} />
      )}
    </>
  );
}

function TeamPick({
  label, value, list, onPick,
}: {
  label: string;
  value: string;
  list: { team_id: string; name: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onPick(e.target.value)}>
      <option value="">{label}…</option>
      {list.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
    </select>
  );
}

const pct = (x: number, n: number) => (n ? Math.round((100 * x) / n) : null);

function CompareBody({
  A, B, mapName, aId, bId,
}: {
  A: ReportResp; B: ReportResp; mapName: string; aId: string; bId: string;
}) {
  return (
    <>
      <div className="cmphead">
        <TeamBadge name={A.team} id={aId} />
        <span className="meta">{mapName}</span>
        <TeamBadge name={B.team} id={bId} right />
      </div>
      {(A.insufficient || B.insufficient) && (
        <p className="error">small sample on at least one side — treat numbers with caution</p>
      )}

      <h2>Head to head numbers</h2>
      <div className="panel">
        <VsRow label="Map record" a={`${A.overview.wins}–${A.overview.matches - A.overview.wins}`}
          b={`${B.overview.wins}–${B.overview.matches - B.overview.wins}`}
          av={A.overview.matches ? A.overview.wins / A.overview.matches : 0}
          bv={B.overview.matches ? B.overview.wins / B.overview.matches : 0}
          an={`${A.overview.matches} matches`} bn={`${B.overview.matches} matches`} />
        <VsRow label="T round win" a={fmtPct(A.overview.t_wins, A.overview.t_rounds)}
          b={fmtPct(B.overview.t_wins, B.overview.t_rounds)}
          av={ratio(A.overview.t_wins, A.overview.t_rounds)} bv={ratio(B.overview.t_wins, B.overview.t_rounds)}
          an={`${A.overview.t_wins}/${A.overview.t_rounds}`} bn={`${B.overview.t_wins}/${B.overview.t_rounds}`} />
        <VsRow label="CT round win" a={fmtPct(A.overview.ct_wins, A.overview.ct_rounds)}
          b={fmtPct(B.overview.ct_wins, B.overview.ct_rounds)}
          av={ratio(A.overview.ct_wins, A.overview.ct_rounds)} bv={ratio(B.overview.ct_wins, B.overview.ct_rounds)}
          an={`${A.overview.ct_wins}/${A.overview.ct_rounds}`} bn={`${B.overview.ct_wins}/${B.overview.ct_rounds}`} />
        <VsRow label="Pistol rounds" a={fmtPct(A.overview.pistol_wins, A.overview.pistol_rounds)}
          b={fmtPct(B.overview.pistol_wins, B.overview.pistol_rounds)}
          av={ratio(A.overview.pistol_wins, A.overview.pistol_rounds)} bv={ratio(B.overview.pistol_wins, B.overview.pistol_rounds)}
          an={`${A.overview.pistol_wins}/${A.overview.pistol_rounds}`} bn={`${B.overview.pistol_wins}/${B.overview.pistol_rounds}`} />
        <VsRow label="Convert after pistol win"
          a={A.overview.conv_after_pistol_win_n ? `${Math.round(100 * A.overview.conv_after_pistol_win)}%` : '—'}
          b={B.overview.conv_after_pistol_win_n ? `${Math.round(100 * B.overview.conv_after_pistol_win)}%` : '—'}
          av={A.overview.conv_after_pistol_win} bv={B.overview.conv_after_pistol_win}
          an={`n=${A.overview.conv_after_pistol_win_n}`} bn={`n=${B.overview.conv_after_pistol_win_n}`} />
      </div>

      <h2>After losing a pistol</h2>
      <div className="grid cards two">
        <BuyMini title={A.team} dist={A.economy.after_pistol_loss} />
        <BuyMini title={B.team} dist={B.economy.after_pistol_loss} />
      </div>

      <h2>Strategy tendencies</h2>
      {(['T', 'CT'] as const).map((side) => (
        <div key={side} className="grid cards two">
          <TendCard rep={A} side={side} />
          <TendCard rep={B} side={side} />
        </div>
      ))}

      <CalibratedNext aId={aId} bId={bId} aName={A.team} bName={B.team} mapName={mapName} />

      <SetupsCompare A={A} B={B} mapName={mapName} />

      <UtilityCompare A={A} B={B} mapName={mapName} />

      <HeatCompare aId={aId} bId={bId} aName={A.team} bName={B.team} mapName={mapName} />

      <VetoSim aId={aId} bId={bId} aName={A.team} bName={B.team} />
    </>
  );
}

// Veto simülasyonu: arşiv harita güçlerinden rasyonel ban/pick planı.
function VetoSim({ aId, bId, aName, bName }: { aId: string; bId: string; aName: string; bName: string }) {
  const [format, setFormat] = useState('bo3');
  const sim = useQuery({
    queryKey: ['veto', aId, bId, format],
    queryFn: async () => {
      const r = await fetch(`/api/v1/veto?a=${aId}&b=${bId}&format=${format}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j as {
        steps: { action: string; map: string; edge: number; n: number }[];
        finals: { map: string; prob_a: number; edge: number; n: number }[];
        pool_maps?: { map: string; prob_a: number; n: number }[];
        note: string;
      };
    },
    retry: false,
  });

  const actLabel: Record<string, string> = {
    banA: `${aName} bans`, banB: `${bName} bans`,
    pickA: `${aName} picks`, pickB: `${bName} picks`, decider: 'decider',
  };

  return (
    <>
      <h2>
        Veto simulation{' '}
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10 }}>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="bo1">BO1</option>
            <option value="bo3">BO3</option>
            <option value="bo5">BO5</option>
          </select>
        </span>
      </h2>
      {sim.error && <p className="meta">{String(sim.error)}</p>}
      {sim.data && (
        <div className="grid cards two">
          <div className="card">
            <div className="teams"><span>Rational veto sequence</span></div>
            <table style={{ marginTop: 6 }}>
              <tbody>
                {sim.data.steps.map((s, i) => (
                  <tr key={i}>
                    <td className="meta">{i + 1}</td>
                    <td>{actLabel[s.action]}</td>
                    <td style={{ fontWeight: 600 }}>{s.map}</td>
                    <td className="meta">
                      edge {s.edge >= 0 ? '+' : ''}{Math.round(100 * s.edge)}% · n={s.n}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="teams"><span>Map pool outlook</span><span className="meta">all shared maps</span></div>
            <table style={{ marginTop: 6 }}>
              <thead>
                <tr><th>Map</th><th>{aName}</th><th>{bName}</th><th className="meta">rounds</th><th /></tr>
              </thead>
              <tbody>
                {(sim.data.pool_maps ?? sim.data.finals).map((f) => {
                  const step = sim.data.steps.find((st) => st.map === f.map);
                  const act = step
                    ? step.action === 'decider' ? 'decider'
                      : step.action.startsWith('pick') ? `pick (${step.action === 'pickA' ? aName : bName})`
                      : `ban (${step.action === 'banA' ? aName : bName})`
                    : '';
                  return (
                    <tr key={f.map} style={{ opacity: act.startsWith('ban') ? 0.55 : 1 }}>
                      <td>{f.map}</td>
                      <td style={{ color: f.prob_a >= 0.5 ? '#7fd88f' : '#e05545', fontWeight: 700 }}>
                        {Math.round(100 * f.prob_a)}%
                      </td>
                      <td style={{ color: f.prob_a < 0.5 ? '#7fd88f' : '#e05545', fontWeight: 700 }}>
                        {Math.round(100 * (1 - f.prob_a))}%
                      </td>
                      <td className="meta">{f.n}</td>
                      <td className="meta">{act}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="meta" style={{ marginTop: 8 }}>
              real archive data: shrunk round-win rates per map, head-to-head
              relative — {sim.data.note}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

const fmtPct = (x: number, n: number) => (n ? `${pct(x, n)}%` : '—');
const ratio = (x: number, n: number) => (n ? x / n : 0);

function TeamBadge({ name, id, right }: { name: string; id: string; right?: boolean }) {
  return (
    <Link to={`/team/${id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: right ? 'row-reverse' : 'row' }}>
      <span className="monogram lg" style={{ background: `hsl(${teamHue(name)},45%,32%)` }}>
        {teamInitials(name)}
      </span>
      <span style={{ fontSize: 18, fontWeight: 700 }}>{name}</span>
    </Link>
  );
}

// İki yönlü metrik satırı: ortada etiket, iki yana bar; iyi taraf parlak.
function VsRow({
  label, a, b, av, bv, an, bn,
}: {
  label: string; a: string; b: string; av: number; bv: number; an: string; bn: string;
}) {
  const max = Math.max(av, bv, 0.0001);
  return (
    <div className="vsrow">
      <span className="val" style={{ color: av >= bv ? '#b6e2b6' : '#8a938c' }}>{a} <i>{an}</i></span>
      <div className="bar left"><div style={{ width: `${(100 * av) / max}%`, opacity: av >= bv ? 1 : 0.45 }} /></div>
      <span className="lbl">{label}</span>
      <div className="bar right"><div style={{ width: `${(100 * bv) / max}%`, opacity: bv >= av ? 1 : 0.45 }} /></div>
      <span className="val" style={{ color: bv >= av ? '#b6e2b6' : '#8a938c', textAlign: 'right' }}><i>{bn}</i> {b}</span>
    </div>
  );
}

function BuyMini({ title, dist }: { title: string; dist: Record<string, number> }) {
  const total = Object.values(dist).reduce((x, y) => x + y, 0);
  const order = ['full', 'force', 'semi', 'eco', 'unknown'];
  return (
    <div className="card">
      <div className="teams"><span>{title}</span><span className="meta">n={total}</span></div>
      {order.filter((k) => dist[k]).map((k) => (
        <MiniBar key={k} prob={total ? dist[k] / total : 0} label={`${k} (${dist[k]})`} />
      ))}
      {!total && <p className="meta">no data</p>}
    </div>
  );
}

function MiniBar({ prob, label }: { prob: number; label: string }) {
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

// Rakip-kalibre sonraki raunt tahmini (B1): her takımın dağılımı ÖTEKİ
// takıma karşı kalibre edilir (opp_id) — yöntem rozetinde h2h/style görünür.
function CalibratedNext({ aId, bId, aName, bName, mapName }: {
  aId: string; bId: string; aName: string; bName: string; mapName: string;
}) {
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const mk = (team: string, opp: string) =>
    new URLSearchParams({ team_id: team, map: mapName, side, opp_id: opp });
  const pA = useQuery({
    queryKey: ['predict', aId, bId, mapName, side],
    queryFn: () => api.predict(mk(aId, bId)),
    enabled: !!mapName,
  });
  const pB = useQuery({
    queryKey: ['predict', bId, aId, mapName, side],
    queryFn: () => api.predict(mk(bId, aId)),
    enabled: !!mapName,
  });
  const METHOD: Record<string, string> = {
    league: 'league', team: 'team', team_buy: 'team+buy',
    team_vs: '⚔ head-to-head', team_style: '🎭 opponent style',
  };
  const card = (name: string, q: typeof pA) => (
    <div className="card">
      <div className="teams">
        <span>{name}</span>
        {q.data && <span className="badge gray">{METHOD[q.data.method] ?? q.data.method}</span>}
      </div>
      {q.data && <div className="meta" style={{ margin: '4px 0' }}>{q.data.evidence.note}</div>}
      {(q.data?.clusters ?? []).slice(0, 4).map((c) => (
        <div key={c.cluster_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <div style={{ flex: '0 0 40px', fontVariantNumeric: 'tabular-nums' }}>%{Math.round(100 * c.prob)}</div>
          <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 8 }}>
            <div style={{ width: `${100 * c.prob}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
          </div>
          <div className="meta" style={{ flex: '0 0 50%' }} title={c.top_places.map((p) => p.place).join(' → ')}>
            {c.label ?? c.top_places.slice(0, 3).map((p) => p.place).join(' → ')}
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <>
      <h2>
        Next round, calibrated to this matchup{' '}
        <span className="hlpick noprint" style={{ fontWeight: 400 }}>
          <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
            <option value="T">both on T-view</option>
            <option value="CT">both on CT-view</option>
          </select>
        </span>
      </h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        each side&apos;s distribution is adjusted for the specific opponent when the
        temporal test favours it — badge shows which calibration is active
      </p>
      <div className="grid cards two">
        {card(`${aName} (${side})`, pA)}
        {card(`${bName} (${side})`, pB)}
      </div>
    </>
  );
}

function TendCard({ rep, side }: { rep: ReportResp; side: 'T' | 'CT' }) {
  const rows = rep.tendencies.filter((t) => t.side === side).slice(0, 3);
  return (
    <div className="card">
      <div className="teams">
        <span>{rep.team} <span className={`badge ${side}`}>{side}</span></span>
        <span className="meta">{rows[0]?.sample_size ?? 0} rounds</span>
      </div>
      {rows.map((t) => (
        <MiniBar key={t.cluster_id} prob={t.prob}
          label={t.label ?? t.top_places.slice(0, 3).map((p) => p.place).join(' → ')} />
      ))}
      {!rows.length && <p className="meta">no data</p>}
    </div>
  );
}

function SetupsCompare({ A, B, mapName }: { A: ReportResp; B: ReportResp; mapName: string }) {
  const [side, setSide] = useState<'T' | 'CT'>('CT');
  return (
    <>
      <h2>
        Default setups <span className="meta">(15 s)</span>{' '}
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10 }}>
          <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
            <option>CT</option><option>T</option>
          </select>
        </span>
      </h2>
      <div className="grid cards two">
        <SetupMini rep={A} mapName={mapName} side={side} />
        <SetupMini rep={B} mapName={mapName} side={side} />
      </div>
    </>
  );
}

function SetupMini({ rep, mapName, side }: { rep: ReportResp; mapName: string; side: 'T' | 'CT' }) {
  const patterns = rep.setups.filter((s) => s.side === side && s.t_offset === 15);
  const setup = patterns[0];
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    if (!setup) return;
    const centro = new Map(base.layout.places.map((p) => [p.name, p]));
    for (const pp of setup.pattern) {
      const c = centro.get(pp.place);
      if (!c) continue;
      const x = (c.rx * MAPW) / RADAR, y = (c.ry * MAPW) / RADAR;
      ctx.fillStyle = '#4d9de0';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0b0e0c'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = '#0b0e0c'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(pp.n), x, y + 4);
      ctx.fillStyle = '#dbe4dc'; ctx.font = '10px system-ui';
      ctx.fillText(pp.place, x, y - 13);
      ctx.textAlign = 'left';
    }
  }, [base, setup, side]);
  return (
    <div className="card">
      <div className="teams">
        <span>{rep.team} <span className={`badge ${side}`}>{side}</span></span>
        <span className="meta">
          {setup ? `${Math.round(100 * setup.share)}% of ${setup.sample_size} rounds` : ''}
        </span>
      </div>
      {!setup && (
        <p className="meta">
          no stable default detected — needs ≥8 {side} rounds on this map
        </p>
      )}
      <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} style={{ marginTop: 6 }} />
      {patterns.length > 1 && (
        <div className="meta" style={{ marginTop: 6, lineHeight: 1.6 }}>
          {patterns.slice(1, 4).map((p) => (
            <div key={p.pattern_id}>
              {Math.round(100 * p.share)}% — {p.pattern.map((x) => `${x.place}×${x.n}`).join(' ')}
              {p.avg_hold_sec != null && ` · holds ~${Math.round(p.avg_hold_sec)}s`}
            </div>
          ))}
        </div>
      )}
      {!setup && <p className="meta">not enough rounds for a reliable pattern</p>}
    </div>
  );
}

const UTIL_CSS: Record<string, string> = {
  smoke: '#b4b9be', molotov: '#eb781e', flash: '#ffffff', he: '#ff8c3c',
};

function UtilityCompare({ A, B, mapName }: { A: ReportResp; B: ReportResp; mapName: string }) {
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const [type, setType] = useState('smoke');
  return (
    <>
      <h2>
        Utility habits{' '}
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10 }}>
          <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
            <option>T</option><option>CT</option>
          </select>
          {['smoke', 'molotov', 'flash'].map((t) => (
            <button key={t} className={t === type ? '' : 'ghost'} onClick={() => setType(t)}>{t}</button>
          ))}
        </span>
      </h2>
      <div className="grid cards two">
        <UtilMap rep={A} mapName={mapName} side={side} type={type} />
        <UtilMap rep={B} mapName={mapName} side={side} type={type} />
      </div>
    </>
  );
}

function UtilMap({ rep, mapName, side, type }: { rep: ReportResp; mapName: string; side: 'T' | 'CT'; type: string }) {
  const spots = useMemo(
    () => rep.utility.filter((u) => u.side === side && u.type === type).slice(0, 8),
    [rep.utility, side, type],
  );
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    const maxC = Math.max(1, ...spots.map((s) => s.count));
    for (const sp of spots) {
      const x = (sp.det_rx * MAPW) / RADAR, y = (sp.det_ry * MAPW) / RADAR;
      const r = 4 + 8 * Math.sqrt(sp.count / maxC);
      ctx.fillStyle = UTIL_CSS[type] ?? '#ccc';
      ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0b0e0c';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    }
  }, [base, spots, type]);
  return (
    <div className="card">
      <div className="teams">
        <span>{rep.team}</span>
        <span className="meta">{spots.length} recurring spots</span>
      </div>
      <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} style={{ marginTop: 6 }} />
      {spots.length > 0 ? (
        <table style={{ marginTop: 6, fontSize: 11.5 }}>
          <tbody>
            {spots.slice(0, 5).map((sp) => (
              <tr key={sp.cluster_id}>
                <td>{sp.label ?? '?'}</td>
                <td>×{sp.count}</td>
                <td className="meta">
                  {sp.t_avg != null ? `~${Math.round(sp.t_avg)}±${Math.round(sp.t_std ?? 0)}s` : ''}
                </td>
                <td className="meta">{Math.round(100 * sp.share)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="meta" style={{ marginTop: 6 }}>no recurring spots yet (needs ≥3 throws per spot)</p>
      )}
    </div>
  );
}

function HeatCompare({
  aId, bId, aName, bName, mapName,
}: {
  aId: string; bId: string; aName: string; bName: string; mapName: string;
}) {
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const [wnd, setWnd] = useState<'0-25' | '25-115'>('0-25');
  const [t0, t1] = wnd === '0-25' ? [0, 25] : [25, 115];
  return (
    <>
      <h2>
        Positioning{' '}
        <span className="toolbar" style={{ display: 'inline-flex', marginLeft: 10 }}>
          <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
            <option>T</option><option>CT</option>
          </select>
          <select value={wnd} onChange={(e) => setWnd(e.target.value as typeof wnd)}>
            <option value="0-25">first 25 s</option>
            <option value="25-115">after 25 s</option>
          </select>
        </span>
      </h2>
      <div className="grid cards two">
        <HeatMini teamId={aId} name={aName} mapName={mapName} side={side} t0={t0} t1={t1} />
        <HeatMini teamId={bId} name={bName} mapName={mapName} side={side} t0={t0} t1={t1} />
      </div>
    </>
  );
}

function HeatMini({
  teamId, name, mapName, side, t0, t1,
}: {
  teamId: string; name: string; mapName: string; side: 'T' | 'CT'; t0: number; t1: number;
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
        <span>{name}</span>
        <span className="meta">{heat.data?.round_count ?? '…'} rounds</span>
      </div>
      <canvas ref={cvRef} className="flat" width={MAPW} height={MAPW} style={{ marginTop: 6 }} />
    </div>
  );
}
