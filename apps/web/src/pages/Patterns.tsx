import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type PatternNade } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';

// Pattern Finder: arşivdeki granat yörüngeleri tek haritada. Kutu çizerek
// bölge filtrele, zamanlama dağılımını oku, rauntlara atla. (Koç örneği:
// "molotofu yalnız 1:43-1:41 arasında atıyorlar" → histogramda tek bakışta.)
const MAPW = 560;
const NADE_COLOR: Record<string, string> = {
  smoke: '#b4b9be', flash: '#f5e19a', he: '#e08585',
  molotov: '#eb781e', incendiary: '#eb781e', decoy: '#8a8f95',
};
const TYPE_GROUPS: [string, string[]][] = [
  ['smoke', ['smoke']], ['flash', ['flash']],
  ['molotov', ['molotov', 'incendiary']], ['he', ['he']], ['decoy', ['decoy']],
];
type Box = { x0: number; y0: number; x1: number; y1: number } | null;

export default function Patterns() {
  const status = useQuery({ queryKey: ['mlstatus'], queryFn: () => api.mlStatus() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.teams() });
  const maps = useMemo(
    () => [...new Set((status.data?.evaluation ?? []).map((e) => e.map_name))].sort(),
    [status.data],
  );

  const [mapName, setMapName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [side, setSide] = useState('');
  const [months, setMonths] = useState('');          // '' = tüm arşiv
  const [types, setTypes] = useState(new Set(['smoke', 'flash', 'molotov']));
  const [playerId, setPlayerId] = useState('');
  const [box, setBox] = useState<Box>(null);
  const [showLines, setShowLines] = useState(false);
  const effMap = mapName || maps[0] || '';

  const since = useMemo(() => {
    if (!months) return '';
    const d = new Date();
    d.setMonth(d.getMonth() - Number(months));
    return d.toISOString().slice(0, 10);
  }, [months]);

  const nadesQ = useQuery({
    queryKey: ['patterns', effMap, teamId, side, since],
    queryFn: () => {
      const p = new URLSearchParams({ map: effMap });
      if (teamId) p.set('team_id', teamId);
      if (side) p.set('side', side);
      if (since) p.set('since', since);
      return api.patterns(p);
    },
    enabled: !!effMap,
  });
  const all = nadesQ.data?.nades ?? [];

  // oyuncu listesi yüklenen veriden türetilir (bu filtre kombinasyonunda
  // gerçekten granat atmış olanlar)
  const throwers = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of all) if (n.player_id && n.thrower) m.set(n.player_id, n.thrower);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  // tür + oyuncu filtreleri istemcide (anlık aç/kapat)
  const active = useMemo(() => {
    const wanted = new Set<string>();
    for (const [g, members] of TYPE_GROUPS) if (types.has(g)) members.forEach((t) => wanted.add(t));
    return all.filter((n) => wanted.has(n.type) && (!playerId || n.player_id === playerId));
  }, [all, types, playerId]);

  // kutu seçimi: düşüş noktası kutunun içinde olanlar
  const selected = useMemo(() => {
    if (!box) return active;
    const [xa, xb] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [ya, yb] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    return active.filter((n) => n.drx >= xa && n.drx <= xb && n.dry >= ya && n.dry <= yb);
  }, [active, box]);

  // TOP PATTERNS: düşüş noktaları 44-birimlik hücrelere gruplanır; tekrar
  // sayısı, zaman penceresi ve en yakın bölge adıyla sıralanır — sayfanın
  // "desen bulucu" tarafı budur (tıklayınca haritada o bölgeye kilitlenir)
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => { if (effMap) loadMapBase(effMap).then(setBase); }, [effMap]);
  const CELL = 44;
  const topSpots = useMemo(() => {
    const cells = new Map<string, { n: number; ts: number[]; x: number; y: number; types: Map<string, number> }>();
    for (const n of active) {
      const key = `${Math.round(n.drx / CELL)}:${Math.round(n.dry / CELL)}`;
      let c = cells.get(key);
      if (!c) { c = { n: 0, ts: [], x: 0, y: 0, types: new Map() }; cells.set(key, c); }
      c.n++; c.ts.push(n.t); c.x += n.drx; c.y += n.dry;
      c.types.set(n.type, (c.types.get(n.type) ?? 0) + 1);
    }
    const places = base?.layout.places ?? [];
    const nameOf = (x: number, y: number) => {
      let best = ''; let bd = Infinity;
      for (const pl of places) {
        const d = (pl.rx - x) ** 2 + (pl.ry - y) ** 2;
        if (d < bd) { bd = d; best = pl.name; }
      }
      return best || 'unknown';
    };
    return [...cells.values()]
      .filter((c) => c.n >= 3)
      .sort((a, b) => b.n - a.n)
      .slice(0, 12)
      .map((c) => {
        const x = c.x / c.n, y = c.y / c.n;
        const mean = c.ts.reduce((a2, b2) => a2 + b2, 0) / c.ts.length;
        const std = Math.sqrt(c.ts.reduce((a2, b2) => a2 + (b2 - mean) ** 2, 0) / c.ts.length);
        const type = [...c.types.entries()].sort((a2, b2) => b2[1] - a2[1])[0][0];
        return { x, y, n: c.n, mean, std, type, place: nameOf(x, y) };
      });
  }, [active, base]);

  // seçimdeki benzersiz rauntlar (replay'e atlama listesi)
  const rounds = useMemo(() => {
    const seen = new Set<string>();
    const out: PatternNade[] = [];
    for (const n of selected) {
      const k = `${n.match_id}:${n.round_number}`;
      if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out;
  }, [selected]);

  return (
    <>
      <h1>🧭 Pattern Finder</h1>
      <p className="meta" style={{ maxWidth: 760 }}>
        Finds a team&apos;s grenade <b>habits</b>: spots they throw to again and
        again, and exactly <i>when</i> in the round. Pick a team (patterns of
        “all teams” are just the map&apos;s standard smokes), then either click a
        row in <b>Top patterns</b> or <b>drag a box on the map</b> — the timing
        chart shows the habit&apos;s clock window (“this molotov only comes at
        1:43–1:41”), and the round list jumps into the replay. Click the map
        once to clear.
      </p>

      <div className="toolbar">
        <select value={effMap} onChange={(e) => { setMapName(e.target.value); setBox(null); }}>
          {maps.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setPlayerId(''); }}>
          <option value="">all teams</option>
          {(teams.data ?? []).filter((t) => t.matches > 0)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="">both sides</option>
          <option value="T">T only</option>
          <option value="CT">CT only</option>
        </select>
        <select value={months} onChange={(e) => setMonths(e.target.value)}>
          <option value="">whole archive</option>
          <option value="6">last 6 months</option>
          <option value="3">last 3 months</option>
          <option value="1">last month</option>
        </select>
        <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
          <option value="">all throwers</option>
          {throwers.map(([id, nm]) => <option key={id} value={id}>{nm}</option>)}
        </select>
      </div>
      <div className="toolbar">
        {TYPE_GROUPS.map(([g]) => (
          <button
            key={g}
            className={types.has(g) ? '' : 'ghost'}
            style={{ color: NADE_COLOR[g] }}
            onClick={() => {
              const next = new Set(types);
              if (next.has(g)) next.delete(g); else next.add(g);
              setTypes(next);
            }}
          >
            {g}
          </button>
        ))}
        <button className={showLines ? '' : 'ghost'} onClick={() => setShowLines(!showLines)}
          title="draw the full throw → landing line for every grenade (gets busy on wide filters)">
          ↗ trajectories
        </button>
        <span className="meta">
          {nadesQ.isFetching ? 'loading…'
            : `${selected.length} grenades${box ? ' in box' : ''} · ${rounds.length} rounds`}
          {nadesQ.data?.truncated && ' · ⚠ showing the newest slice of the archive — narrow the filters'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <PatternCanvas base={base} nades={active} spots={topSpots}
          showLines={showLines} box={box} onBox={setBox} />
        <div style={{ flex: '1 1 320px', minWidth: 300 }}>
          <h3 style={{ margin: '0 0 4px' }}>
            Top patterns{' '}
            <span className="meta">— most repeated landing spots; click one to focus it</span>
          </h3>
          {topSpots.map((sp, i) => {
            const half = CELL * 0.75;
            const isSel = box && Math.abs((box.x0 + box.x1) / 2 - sp.x) < 2 && Math.abs((box.y0 + box.y1) / 2 - sp.y) < 2;
            return (
              <div
                key={i}
                onClick={() => setBox(isSel ? null
                  : { x0: sp.x - half, y0: sp.y - half, x1: sp.x + half, y1: sp.y + half })}
                style={{ cursor: 'pointer', lineHeight: 1.9, padding: '0 6px', borderRadius: 4,
                  background: isSel ? 'rgba(76,143,82,.18)' : undefined }}
              >
                <span style={{ color: NADE_COLOR[sp.type] }}>{sp.type}</span>{' '}
                → <b>{sp.place}</b> <span className="meta">×{sp.n} · usually at {fmtT(sp.mean)}
                {sp.std < 12 ? ` ±${Math.round(sp.std)}s` : ' (timing varies)'}</span>
              </div>
            );
          })}
          {!topSpots.length && !nadesQ.isFetching && (
            <p className="meta">no repeated spots (3+) with these filters</p>
          )}
          <div style={{ marginTop: 14 }} />
          <TimingHistogram nades={selected} />
          <h3 style={{ marginTop: 14 }}>
            Rounds <span className="meta">({rounds.length}{box ? ' — landing in your box' : ''})</span>
          </h3>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {rounds.slice(0, 40).map((n) => (
              <div key={`${n.match_id}:${n.round_number}`} style={{ lineHeight: 1.8 }}>
                <Link to={`/match/${n.match_id}?round=${n.round_number}`}>
                  ▶ r{n.round_number}
                </Link>{' '}
                <span className="meta">
                  {n.type} by {n.thrower || '?'} at {fmtT(n.t)} <span className={`badge ${n.side}`}>{n.side}</span>
                </span>
              </div>
            ))}
            {rounds.length > 40 && <p className="meta">…and {rounds.length - 40} more — narrow the box</p>}
            {!rounds.length && !nadesQ.isFetching && <p className="meta">nothing here — widen the filters</p>}
          </div>
        </div>
      </div>
    </>
  );
}

function fmtT(t: number): string {
  // raunt saati MR12'de 1:55'ten geri sayar — koçların konuştuğu dil
  const remain = Math.max(0, Math.round(115 - t));
  return `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`;
}

function PatternCanvas({ base, nades, spots, showLines, box, onBox }: {
  base: MapBase | null; nades: PatternNade[];
  spots: { x: number; y: number; n: number; type: string }[];
  showLines: boolean; box: Box; onBox: (b: Box) => void;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Box>(null);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    const k = MAPW / RADAR;
    for (const n of nades) {
      const col = NADE_COLOR[n.type] ?? '#fff';
      if (showLines) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.13;
        ctx.beginPath();
        ctx.moveTo(n.trx * k, n.try * k);
        ctx.lineTo(n.drx * k, n.dry * k);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = col;
      ctx.fillRect(n.drx * k - 1.4, n.dry * k - 1.4, 2.8, 2.8);
    }
    // tekrar rozetleri: desenin kendisi haritada görünür (×N)
    ctx.globalAlpha = 1;
    for (const sp of spots) {
      const x = sp.x * k, y = sp.y * k;
      ctx.fillStyle = NADE_COLOR[sp.type] ?? '#fff';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0b0e0c'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = '#0b0e0c'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(sp.n), x, y + 3.5);
    }
    ctx.textAlign = 'left';
    const b = drag ?? box;
    if (b) {
      ctx.strokeStyle = '#8fd39a';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(b.x0, b.x1) * k, Math.min(b.y0, b.y1) * k,
        Math.abs(b.x1 - b.x0) * k, Math.abs(b.y1 - b.y0) * k,
      );
      ctx.setLineDash([]);
    }
  }, [base, nades, spots, showLines, box, drag]);

  const toRadar = (e: React.MouseEvent) => {
    const r = cvRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * RADAR,
      y: ((e.clientY - r.top) / r.height) * RADAR,
    };
  };
  return (
    <canvas
      ref={cvRef}
      className="flat"
      width={MAPW}
      height={MAPW}
      style={{ cursor: 'crosshair', touchAction: 'none' }}
      onMouseDown={(e) => { dragRef.current = toRadar(e); }}
      onMouseMove={(e) => {
        if (!dragRef.current) return;
        const p = toRadar(e);
        setDrag({ x0: dragRef.current.x, y0: dragRef.current.y, x1: p.x, y1: p.y });
      }}
      onMouseUp={(e) => {
        const start = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!start) return;
        const p = toRadar(e);
        // 8 radar-birimden küçük sürükleme = tık → kutuyu temizle
        if (Math.abs(p.x - start.x) < 8 && Math.abs(p.y - start.y) < 8) onBox(null);
        else onBox({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
      }}
      onMouseLeave={() => { dragRef.current = null; setDrag(null); }}
    />
  );
}

function TimingHistogram({ nades }: { nades: PatternNade[] }) {
  // 5 sn'lik kovalar (0-115 sn) — çubuğun üstüne gel: aralık + adet
  const buckets = useMemo(() => {
    const b = new Array(23).fill(0);
    for (const n of nades) {
      const i = Math.min(22, Math.max(0, Math.floor(n.t / 5)));
      b[i]++;
    }
    return b as number[];
  }, [nades]);
  const max = Math.max(1, ...buckets);
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>
        When are they thrown?{' '}
        <span className="meta">(round clock, counting down from 1:55)</span>
      </h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 90 }}>
        {buckets.map((n, i) => {
          const from = 115 - i * 5, to = Math.max(0, 115 - (i + 1) * 5);
          const lbl = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          return (
            <div
              key={i}
              title={`${lbl(from)} → ${lbl(to)}: ${n} grenades`}
              style={{
                flex: 1, height: `${(100 * n) / max}%`, minHeight: n ? 2 : 0,
                background: '#4c8f52', borderRadius: 2, opacity: n ? 0.9 : 0.25,
              }}
            />
          );
        })}
      </div>
      <div className="meta" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>1:55</span><span>1:00</span><span>0:00</span>
      </div>
    </div>
  );
}
