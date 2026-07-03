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
    // Önce vektör (SVG) denenir — zoom'da çözünürlük sınırı yok;
    // yoksa PNG'ye düşülür.
    const tryLoad = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    p = tryLoad(`/radars/${map}.svg`).then((svg) => svg ?? tryLoad(`/radars/${map}.png`));
    imgCache.set(map, p);
  }
  return p;
}

/** Zemin görseli vektör mü (SVG rasterizasyonu her boyutta keskindir). */
export function isVectorBase(base: MapBase): boolean {
  return !!base.radarImg && base.radarImg.src.endsWith('.svg');
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
    // yazı boyutu tuval çözünürlüğüyle ölçeklenir (yüksek DPI'da net)
    const fs = Math.max(10, Math.round(w / 72));
    ctx.font = `${fs}px system-ui`;
    ctx.textAlign = 'center';
    for (const p of base.layout.places) {
      const x = (p.rx * w) / RADAR;
      const y = (p.ry * w) / RADAR;
      const half = (p.name.length * fs * 0.29) + fs * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - half, y - fs * 0.8, half * 2, fs * 1.1);
      ctx.fillStyle = 'rgba(200,215,205,0.9)';
      ctx.fillText(p.name, x, y);
    }
    ctx.textAlign = 'left';
  }
}

/** Ekran DPI'sı (2 ile sınırlı — 4K'da bellek şişmesin). */
export const DPR = Math.min(window.devicePixelRatio || 1, 2);

/** 2D canvas'ı yüksek DPI'ya kurar: fiziksel piksel = css × DPR. */
export function hidpiCtx(cv: HTMLCanvasElement, cssSize: number): CanvasRenderingContext2D {
  cv.width = cssSize * DPR;
  cv.height = cssSize * DPR;
  cv.style.width = `${cssSize}px`;
  cv.style.height = `${cssSize}px`;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return ctx;
}

/* --- Çok katlı haritalarda alt kat inset'i (sağ üst mini harita) ---
   Replay'deki turnuva düzeninin 2D canvas eşleniği; Overlay ve Heatmap
   görünümleri de aynı geometriyi kullanır. */

export interface InsetGeom { x: number; y: number; size: number }

export function insetGeom(w: number): InsetGeom {
  const size = Math.round(w * 0.33); // çerçevesiz, hafif küçük — üst üste binmesin
  return { x: w - size - 6, y: 6, size };
}

/** Alt kat zeminini + etiketi çizer (çerçevesiz; ana içerikten SONRA çağır). */
export function drawLowerInset(ctx: CanvasRenderingContext2D, w: number, base: MapBase): InsetGeom {
  const g = insetGeom(w);
  const tmp = document.createElement('canvas');
  tmp.width = g.size * DPR;
  tmp.height = g.size * DPR;
  drawMapBase(tmp.getContext('2d')!, g.size * DPR, base, false, 'lower');
  ctx.drawImage(tmp, g.x, g.y, g.size, g.size);
  ctx.fillStyle = 'rgba(159,199,159,0.85)';
  ctx.font = '9px system-ui';
  ctx.fillText('LOWER', g.x + 4, g.y + g.size - 5);
  return g;
}

/** Radar koordinatını doğru görünüme yerleştirir (s = boyut ölçeği). */
export function makePlace(w: number, hasLower: boolean) {
  const g = insetGeom(w);
  return (rx: number, ry: number, lower?: boolean | null) => {
    if (hasLower && lower) {
      return { x: g.x + (rx * g.size) / RADAR, y: g.y + (ry * g.size) / RADAR, s: g.size / w };
    }
    return { x: (rx * w) / RADAR, y: (ry * w) / RADAR, s: 1 };
  };
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
