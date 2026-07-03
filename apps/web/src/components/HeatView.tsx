import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type RoundRow } from '../api';
import { drawLowerInset, drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';
import { chipTitle, isSideSwap, winnerTeamClass } from '../lib/rounds';

const HW = 720;

// Futbol tarzı ısı haritası: yoğunluk radyal lekelerle offscreen'e çizilir,
// sonra mavi→camgöbeği→yeşil→sarı→kırmızı paletiyle renklendirilir.
const PALETTE_STOPS: [number, [number, number, number]][] = [
  [0.0, [26, 66, 160]],
  [0.25, [40, 170, 190]],
  [0.5, [60, 180, 75]],
  [0.75, [235, 210, 60]],
  [1.0, [225, 45, 30]],
];

function paletteLUT(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let j = 0;
    while (j < PALETTE_STOPS.length - 2 && v > PALETTE_STOPS[j + 1][0]) j++;
    const [v0, c0] = PALETTE_STOPS[j];
    const [v1, c1] = PALETTE_STOPS[j + 1];
    const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * t;
  }
  return lut;
}
const LUT = paletteLUT();

export default function HeatView({
  matchId, mapName, rounds, teams,
}: {
  matchId: string;
  mapName: string;
  rounds: RoundRow[];
  teams: { aId: string | null; a: string | null; b: string | null };
}) {
  const [side, setSide] = useState('T');
  const [player, setPlayer] = useState('');
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(115);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(rounds.map((r) => r.round_number)), // varsayılan: tüm rauntlar
  );
  const [base, setBase] = useState<MapBase | null>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);

  const players = useQuery({
    queryKey: ['matchPlayers', matchId],
    queryFn: () => api.matchPlayers(matchId),
  });

  const roundKey = useMemo(() => [...selected].sort((a, b) => a - b).join(','), [selected]);
  const heat = useQuery({
    queryKey: ['matchHeat', matchId, side, player, roundKey, t0, t1],
    queryFn: () => {
      const p = new URLSearchParams({ t0: String(Math.min(t0, t1)), t1: String(Math.max(t0, t1)) });
      if (side) p.set('side', side);
      if (player) p.set('player_id', player);
      p.set('rounds', roundKey);
      return api.matchHeatmap(matchId, p);
    },
    enabled: selected.size > 0,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, HW);
    drawMapBase(ctx, HW, base, true);
    const d = heat.data;
    if (!d) return;

    // yoğunluk katmanı: hücre başına radyal leke → palet renklendirmesi.
    // maxW iki kat genelinde ortaktır: inset'teki kırmızı ile ana haritadaki
    // kırmızı aynı yoğunluğu anlatır.
    let maxW = 0;
    for (const [, , w] of d.cells) maxW = Math.max(maxW, w);
    for (const [, , w] of d.cells_lower ?? []) maxW = Math.max(maxW, w);
    if (maxW === 0) return;

    const renderLayer = (cells: [number, number, number][], size: number) => {
      const off = document.createElement('canvas');
      off.width = size; off.height = size;
      const octx = off.getContext('2d')!;
      const cellPx = (d.cell_radar * size) / RADAR;
      const R = cellPx * 2.2; // leke yarıçapı: komşu hücrelerle kaynaşır
      for (const [cx, cy, w] of cells) {
        const x = (cx + 0.5) * cellPx;
        const y = (cy + 0.5) * cellPx;
        if (x < -R || y < -R || x > size + R || y > size + R) continue;
        const a = Math.pow(w / maxW, 0.55) * 0.55; // gamma: orta yoğunluklar görünür
        const g = octx.createRadialGradient(x, y, 0, x, y, R);
        g.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        octx.fillStyle = g;
        octx.fillRect(x - R, y - R, 2 * R, 2 * R);
      }
      // renklendirme: birikmiş alfa → palet (futbol ısı haritası görünümü)
      const img = octx.getImageData(0, 0, size, size);
      const px = img.data;
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (a < 6) { px[i + 3] = 0; continue; }
        const v = Math.min(255, a);
        px[i] = LUT[v * 3];
        px[i + 1] = LUT[v * 3 + 1];
        px[i + 2] = LUT[v * 3 + 2];
        px[i + 3] = Math.min(215, 40 + a * 1.1);
      }
      octx.putImageData(img, 0, 0);
      return off;
    };

    if (d.cells.length) ctx.drawImage(renderLayer(d.cells, HW), 0, 0, HW, HW);
    if (d.radar.has_lower) {
      const g = drawLowerInset(ctx, HW, base); // inset zemini üst ısının üstüne
      if (d.cells_lower?.length) {
        ctx.drawImage(renderLayer(d.cells_lower, g.size), g.x, g.y, g.size, g.size);
      }
    }
  }, [heat.data, base]);

  const allSelected = selected.size === rounds.length;

  return (
    <>
      <div className="roundchips">
        {rounds.map((r, i) => (
          <Fragment key={r.round_number}>
            {isSideSwap(rounds[i - 1], r) && <span className="halfdiv" title="side swap" />}
            <button
              className={`${winnerTeamClass(r, teams.aId)} win${r.winner_side ?? ''} ${selected.has(r.round_number) ? 'sel' : ''}`}
              onClick={() => {
                const s = new Set(selected);
                if (s.has(r.round_number)) s.delete(r.round_number);
                else s.add(r.round_number);
                setSelected(s);
              }}
              title={chipTitle(r, teams)}
            >
              {r.round_number}
            </button>
          </Fragment>
        ))}
        <button
          className="ghost"
          style={{ width: 'auto', padding: '0 8px' }}
          onClick={() => setSelected(allSelected ? new Set() : new Set(rounds.map((r) => r.round_number)))}
        >
          {allSelected ? 'None' : 'All'}
        </button>
      </div>
      <div className="toolbar">
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option>T</option><option>CT</option><option value="">both sides</option>
        </select>
        <select value={player} onChange={(e) => setPlayer(e.target.value)}>
          <option value="">all players</option>
          {(players.data ?? []).map((p) => (
            <option key={p.player_id} value={p.player_id}>{p.nickname}</option>
          ))}
        </select>
        <label>{Math.min(t0, t1)}–{Math.max(t0, t1)} s into round</label>
        <input type="range" min={0} max={115} value={t0} onChange={(e) => setT0(Number(e.target.value))} style={{ width: 160 }} />
        <input type="range" min={0} max={115} value={t1} onChange={(e) => setT1(Number(e.target.value))} style={{ width: 160 }} />
        <span className="meta">
          {selected.size === 0 ? 'pick rounds above' :
            heat.isFetching ? 'computing…' :
            heat.data && heat.data.cells.length === 0 ?
              'no data for this combination (was the player on this side in these rounds?)' :
            heat.data ? `${heat.data.round_count} rounds` : ''}
        </span>
        {heat.error && <span className="error">{String(heat.error)}</span>}
      </div>
      <canvas ref={cvRef} className="flat" width={HW} height={HW} />
    </>
  );
}
