import { useEffect, useRef, useState } from 'react';
import { api, type HeatmapResp } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';

const HW = 720;

// Bu maçın ısı haritası (heatmap?match_id=): taraf + zaman aralığı.
export default function HeatView({ matchId, mapName }: { matchId: string; mapName: string }) {
  const [side, setSide] = useState('T');
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(40);
  const [data, setData] = useState<HeatmapResp | null>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  const [err, setErr] = useState('');
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    (async () => {
      setErr('');
      try {
        const p = new URLSearchParams({ map: mapName, side, match_id: matchId });
        setData(await api.heatmap(p));
        setBase(await loadMapBase(mapName));
      } catch (e) { setErr(String(e)); }
    })();
  }, [matchId, mapName, side]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !data || !base) return;
    const ctx = hidpiCtx(cv, HW);
    drawMapBase(ctx, HW, base, true);
    if (!data.radar) return;
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    const agg = new Map<string, number>();
    let maxv = 0;
    for (const bk of data.buckets) {
      if (bk.t < lo || bk.t > hi) continue;
      for (const [gx, gy, p] of bk.cells) {
        const k = `${gx}:${gy}`;
        const v = (agg.get(k) || 0) + p;
        agg.set(k, v);
        if (v > maxv) maxv = v;
      }
    }
    const cal = data.radar;
    const cellW = ((16 / cal.scale) * HW) / RADAR;
    for (const [k, v] of agg) {
      const [gx, gy] = k.split(':').map(Number);
      const rx = (gx * 16 - cal.pos_x) / cal.scale;
      const ry = (cal.pos_y - (gy + 1) * 16) / cal.scale;
      const i = Math.pow(v / maxv, 0.45);
      ctx.fillStyle = `rgba(${Math.round(255 * i)}, ${Math.round(80 * i)}, 40, ${(0.15 + 0.6 * i).toFixed(3)})`;
      ctx.fillRect((rx * HW) / RADAR, (ry * HW) / RADAR, cellW + 0.5, cellW + 0.5);
    }
  }, [data, base, t0, t1]);

  return (
    <>
      <div className="toolbar">
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option>T</option><option>CT</option>
        </select>
        <label>{Math.min(t0, t1)}–{Math.max(t0, t1)} sn</label>
        <input type="range" min={0} max={115} value={t0} onChange={(e) => setT0(Number(e.target.value))} style={{ width: 180 }} />
        <input type="range" min={0} max={115} value={t1} onChange={(e) => setT1(Number(e.target.value))} style={{ width: 180 }} />
        {data && <span className="meta">{data.round_count} raunt</span>}
        {err && <span className="error">{err}</span>}
      </div>
      <canvas ref={cvRef} className="flat" width={HW} height={HW} />
    </>
  );
}
