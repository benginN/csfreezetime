// Harita arka planı: gerçek radar PNG (static/radars) varsa o, yoksa
// pozisyon verisinden türetilen yürünebilir-alan silüeti. Hem canvas 2D
// hem PixiJS (offscreen canvas → texture) tarafından kullanılır.
import { api, type MapLayout } from '../api';

export const RADAR = 1024;

const layoutCache = new Map<string, Promise<MapLayout>>();
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();

export function getLayout(map: string): Promise<MapLayout> {
  let p = layoutCache.get(map);
  if (!p) {
    p = api.mapLayout(map);
    layoutCache.set(map, p);
  }
  return p;
}

export function getRadarImage(map: string): Promise<HTMLImageElement | null> {
  let p = imgCache.get(map);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `/radars/${map}.png`;
    });
    imgCache.set(map, p);
  }
  return p;
}

export interface MapBase {
  layout: MapLayout;
  radarImg: HTMLImageElement | null;      // üst kat (tek katlıda tek görsel)
  radarImgLower: HTMLImageElement | null; // alt kat (de_<harita>_lower.png)
}

export type MapLevel = 'upper' | 'lower';

export async function loadMapBase(map: string): Promise<MapBase> {
  const [layout, radarImg, radarImgLower] = await Promise.all([
    getLayout(map),
    getRadarImage(map),
    getRadarImage(map + '_lower'),
  ]);
  return { layout, radarImg, radarImgLower };
}

/** Harita arka planını verilen 2D context'e çizer (w×w piksel). */
export function drawMapBase(
  ctx: CanvasRenderingContext2D,
  w: number,
  base: MapBase,
  showLabels: boolean,
  level: MapLevel = 'upper',
): void {
  ctx.fillStyle = '#0b0e0c';
  ctx.fillRect(0, 0, w, w);
  const img = level === 'lower' ? (base.radarImgLower ?? base.radarImg) : base.radarImg;
  if (img) {
    ctx.globalAlpha = 0.85;
    ctx.drawImage(img, 0, 0, w, w);
    ctx.globalAlpha = 1;
  } else {
    const { layout } = base;
    const cells = level === 'lower' && layout.cells_lower ? layout.cells_lower : layout.cells;
    const cell = (layout.cell_px * w) / RADAR;
    let maxc = 0;
    for (const [, , c] of cells) maxc = Math.max(maxc, c);
    const lmax = Math.log(maxc + 1);
    for (const [cx, cy, c] of cells) {
      const a = 0.1 + (0.3 * Math.log(c + 1)) / lmax;
      ctx.fillStyle = `rgba(120,140,125,${a.toFixed(3)})`;
      ctx.fillRect(cx * cell, cy * cell, cell + 0.5, cell + 0.5);
    }
  }
  if (showLabels) {
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    for (const p of base.layout.places) {
      const x = (p.rx * w) / RADAR;
      const y = (p.ry * w) / RADAR;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - p.name.length * 2.8 - 3, y - 8, p.name.length * 5.6 + 6, 11);
      ctx.fillStyle = 'rgba(200,215,205,0.85)';
      ctx.fillText(p.name, x, y);
    }
    ctx.textAlign = 'left';
  }
}

/** PixiJS için: harita arka planını offscreen canvas olarak üretir. */
export function renderMapBaseCanvas(
  base: MapBase,
  w: number,
  showLabels: boolean,
  level: MapLevel = 'upper',
): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = w;
  drawMapBase(cv.getContext('2d')!, w, base, showLabels, level);
  return cv;
}

export const SIDE_COLOR: Record<string, number> = { T: 0xe8a33d, CT: 0x4d9de0 };
export const SIDE_CSS: Record<string, string> = { T: '#e8a33d', CT: '#4d9de0' };
