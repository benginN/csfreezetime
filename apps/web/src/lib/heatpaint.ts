// Futbol tarzı ısı boyama: radyal yoğunluk lekeleri → renk paleti.
// HeatView (maç) ve Report (takım arşivi) paylaşır.
import { drawLowerInset, RADAR, type MapBase } from './mapbase';

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
export const HEAT_LUT = paletteLUT();

export interface HeatCells {
  cells: [number, number, number][];
  cells_lower?: [number, number, number][];
  cell_radar: number;
  radar: { has_lower: boolean };
}

/** Tek katmanın yoğunluk+renk tuvalini üretir (size×size CSS piksel). */
export function renderHeatLayer(
  cells: [number, number, number][],
  size: number,
  cellRadar: number,
  maxW: number,
): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d')!;
  const cellPx = (cellRadar * size) / RADAR;
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
  const img = octx.getImageData(0, 0, size, size);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a < 6) { px[i + 3] = 0; continue; }
    const v = Math.min(255, a);
    px[i] = HEAT_LUT[v * 3];
    px[i + 1] = HEAT_LUT[v * 3 + 1];
    px[i + 2] = HEAT_LUT[v * 3 + 2];
    px[i + 3] = Math.min(215, 40 + a * 1.1);
  }
  octx.putImageData(img, 0, 0);
  return off;
}

/** Harita zemini çizilmiş ctx'in üstüne ısıyı (varsa alt kat inset'iyle) boyar. */
export function paintHeat(
  ctx: CanvasRenderingContext2D,
  w: number,
  base: MapBase,
  d: HeatCells,
): void {
  let maxW = 0;
  for (const [, , wt] of d.cells) maxW = Math.max(maxW, wt);
  for (const [, , wt] of d.cells_lower ?? []) maxW = Math.max(maxW, wt);
  if (maxW === 0) return;
  if (d.cells.length) ctx.drawImage(renderHeatLayer(d.cells, w, d.cell_radar, maxW), 0, 0, w, w);
  if (d.radar.has_lower) {
    const g = drawLowerInset(ctx, w, base);
    if (d.cells_lower?.length) {
      ctx.drawImage(renderHeatLayer(d.cells_lower, g.size, d.cell_radar, maxW), g.x, g.y, g.size, g.size);
    }
  }
}
