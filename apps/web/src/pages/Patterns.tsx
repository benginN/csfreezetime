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
        Every grenade in the archive for one map, drawn as a throw → landing
        line. Narrow it with the filters, then <b>drag a box on the map</b> to
        isolate grenades landing in one area — the timing chart below tells you
        exactly <i>when</i> in the round they come (e.g. “this molotov only
        shows up between 1:43–1:41”), and the round list jumps straight into
        the replay. Click the map once to clear the box.
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
        <span className="meta">
          {nadesQ.isFetching ? 'loading…'
            : `${selected.length} grenades${box ? ' in box' : ''} · ${rounds.length} rounds`}
          {nadesQ.data?.truncated && ' · ⚠ showing newest 8000 — narrow the filters'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <PatternCanvas map={effMap} nades={active} box={box} onBox={setBox} />
        <div style={{ flex: '1 1 320px', minWidth: 300 }}>
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

function PatternCanvas({ map, nades, box, onBox }: {
  map: string; nades: PatternNade[]; box: Box; onBox: (b: Box) => void;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Box>(null);
  useEffect(() => { loadMapBase(map).then(setBase); }, [map]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, MAPW);
    drawMapBase(ctx, MAPW, base, false);
    const k = MAPW / RADAR;
    for (const n of nades) {
      const col = NADE_COLOR[n.type] ?? '#fff';
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.13;
      ctx.beginPath();
      ctx.moveTo(n.trx * k, n.try * k);
      ctx.lineTo(n.drx * k, n.dry * k);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = col;
      ctx.fillRect(n.drx * k - 1.2, n.dry * k - 1.2, 2.4, 2.4);
    }
    ctx.globalAlpha = 1;
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
  }, [base, nades, box, drag]);

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
