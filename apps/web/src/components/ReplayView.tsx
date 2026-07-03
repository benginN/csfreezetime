import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { api, type KillRow, type RoundRow, type StackResp } from '../api';
import { DPR, insetGeom, isVectorBase, loadMapBase, renderMapBaseCanvas, RADAR, SIDE_COLOR, type MapBase } from '../lib/mapbase';
import { renderHeatLayer } from '../lib/heatpaint';
import { chipTitle, isSideSwap, winnerTeamClass } from '../lib/rounds';

const W = 860;
// Zemin dokusu için aşırı örnekleme: zoom'da bloklaşmayı azaltır
// (kaynak PNG 1024 olduğundan ~4x üstü yine yumuşar ama pikselleşmez)
const BASE_OVERSAMPLE = 2;      // PNG kaynak: 2x yeterli
const VECTOR_OVERSAMPLE = 3;    // SVG kaynak: daha yükseğe değer (keskin kalır)
const NADE_LIFE: Record<string, number> = { smoke: 20, molotov: 7, incendiary: 7, flash: 0.7, he: 0.7, decoy: 15 };
const GHOST_TRAIL = 8;   // sn — hayalet iz uzunluğu
const ghostHue = (i: number) => Math.round((i * 137.508) % 360);

// t dizisi artan sıralı: pencere başlangıcının indeksi (ikili arama)
function lowerBound(arr: number[], v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hslToRgbHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (k: number) => {
    const kk = (k + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(kk - 3, Math.min(9 - kk, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

interface HudRow {
  nick: string;
  side: string;
  hp: number;
  armor: number;
  weapon: string;
  money: number | null;
  inv: string;
  k: number; a: number; d: number;
  alive: boolean;
}

// Envanter kısaltmaları: bıçak/taban silahlar sadeleşsin
function shortInv(inv: string[] | null): string {
  if (!inv) return '';
  return inv
    .filter((w) => !w.includes('Knife') && w !== 'C4')
    .map((w) => w.replace('High Explosive Grenade', 'HE').replace('Incendiary Grenade', 'Molotov'))
    .join(' · ');
}

export default function ReplayView({
  matchId, round, onRound, seekTick, matchKills, rounds, teams, header,
}: {
  matchId: string;
  round: number;
  onRound: (n: number) => void;
  seekTick: number | null;
  matchKills: KillRow[];
  rounds: RoundRow[];
  teams: { aId: string | null; a: string | null; b: string | null };
  header?: React.ReactNode;
}) {
  const ticksQ = useQuery({
    queryKey: ['ticks', matchId, round],
    queryFn: () => api.roundTicks(matchId, round),
  });
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => {
    if (ticksQ.data) loadMapBase(ticksQ.data.map_name).then(setBase);
  }, [ticksQ.data]);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [showNames, setShowNames] = useState(true);   // oyuncu adları
  const [showPlaces, setShowPlaces] = useState(true); // harita bölge adları
  const [clock, setClock] = useState('0:00');
  const [hudRows, setHudRows] = useState<HudRow[]>([]);

  // --- Katmanlar: üçü de aynı haritayı kullanır ama tamamen BAĞIMSIZDIR ---
  const [showReplay, setShowReplay] = useState(true);
  const [heatOn, setHeatOn] = useState(false);
  const [heatSide, setHeatSide] = useState<'T' | 'CT' | 'both'>('T');
  const [heatPlayer, setHeatPlayer] = useState('');
  const [heatRounds, setHeatRounds] = useState<Set<number>>(
    () => new Set(rounds.map((r) => r.round_number)), // ısının KENDİ raunt seçimi
  );
  const [ghostsOn, setGhostsOn] = useState(false);
  const [ghostRounds, setGhostRounds] = useState<Set<number>>(new Set());
  const [ghostSide, setGhostSide] = useState<'T' | 'CT' | 'both'>('T');
  const [ghostPlayer, setGhostPlayer] = useState(''); // '' = tüm oyuncular
  const ghostPlayerRef = useRef('');
  ghostPlayerRef.current = ghostPlayer;
  // haritada tıklanan oyuncu: zaman çubuğu onun olaylarını gösterir
  const [selPlayer, setSelPlayer] = useState('');
  const selPlayerRef = useRef('');
  selPlayerRef.current = selPlayer;
  // hayaletlerin KENDİ saati (replay saatinden bağımsız oynar)
  const [ghostPlaying, setGhostPlaying] = useState(false);
  const [ghostSpeed, setGhostSpeed] = useState(2);
  const [ghostClock, setGhostClock] = useState('0:00');
  const ghostTimeRef = useRef(0);
  const ghostPlayingRef = useRef(false);
  const ghostSpeedRef = useRef(2);
  const ghostSliderRef = useRef<HTMLInputElement>(null);
  ghostPlayingRef.current = ghostPlaying;
  ghostSpeedRef.current = ghostSpeed;

  const players = useQuery({
    queryKey: ['matchPlayers', matchId],
    queryFn: () => api.matchPlayers(matchId),
  });
  const ghostKey = useMemo(() => [...ghostRounds].sort((a, b) => a - b).join(','), [ghostRounds]);
  const heatKey = useMemo(() => [...heatRounds].sort((a, b) => a - b).join(','), [heatRounds]);
  const heatQ = useQuery({
    queryKey: ['mergedHeat', matchId, heatSide, heatPlayer, heatKey],
    enabled: heatOn && heatRounds.size > 0,
    queryFn: () => {
      const p = new URLSearchParams({ t0: '0', t1: '115', rounds: heatKey });
      if (heatSide !== 'both') p.set('side', heatSide);
      if (heatPlayer) p.set('player_id', heatPlayer);
      return api.matchHeatmap(matchId, p);
    },
    placeholderData: (prev) => prev,
  });
  const ghostQ = useQuery({
    queryKey: ['ghosts', matchId, ghostKey, ghostSide],
    enabled: ghostRounds.size > 0,
    queryFn: () => api.stack({
      rounds: [...ghostRounds].sort((a, b) => a - b)
        .map((n) => ({ match_id: matchId, round_number: n })),
      align: 'round_start',
      side: ghostSide === 'both' ? undefined : ghostSide,
    }),
    placeholderData: (prev) => prev,
  });
  const ghostDataRef = useRef<StackResp | null>(null);
  useEffect(() => {
    ghostDataRef.current = ghostRounds.size ? (ghostQ.data ?? null) : null;
  }, [ghostQ.data, ghostRounds.size]);
  // ısı tuvali: hazır olduğunda draw döngüsü dokuyu tembelce uygular
  const heatCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!heatOn || !heatQ.data) {
      heatCanvasRef.current = null;
      return;
    }
    const d = heatQ.data;
    let maxW = 0;
    for (const [, , wt] of d.cells) maxW = Math.max(maxW, wt);
    for (const [, , wt] of d.cells_lower ?? []) maxW = Math.max(maxW, wt);
    if (!maxW) { heatCanvasRef.current = null; return; }
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = W;
    const ctx = cv.getContext('2d')!;
    if (d.cells.length) ctx.drawImage(renderHeatLayer(d.cells, W, d.cell_radar, maxW), 0, 0);
    if (d.radar.has_lower && d.cells_lower?.length) {
      const g = insetGeom(W);
      ctx.drawImage(renderHeatLayer(d.cells_lower, g.size, d.cell_radar, maxW), g.x, g.y);
    }
    heatCanvasRef.current = cv;
  }, [heatQ.data, heatOn]);

  const stageRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const zoomApiRef = useRef<{ zoomIn(): void; zoomOut(): void; reset(): void } | null>(null);
  const fIdxRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(2);
  const namesRef = useRef(true);         // sahne yeniden kurulmadan okunur
  const replayOnRef = useRef(true);
  const ghostsOnRef = useRef(false);
  const baseSpriteRef = useRef<Sprite | null>(null);
  playingRef.current = playing;
  speedRef.current = speed;
  namesRef.current = showNames;
  replayOnRef.current = showReplay;
  ghostsOnRef.current = ghostsOn;

  // Bölge adı düğmesi yalnızca arka plan dokusunu tazeler — oynatma sıfırlanmaz
  useEffect(() => {
    const sp = baseSpriteRef.current;
    if (sp && base) {
      const old = sp.texture;
      sp.texture = Texture.from(renderMapBaseCanvas(base, W * DPR * (isVectorBase(base) ? VECTOR_OVERSAMPLE : BASE_OVERSAMPLE), showPlaces, 'upper'));
      sp.setSize(W, W);
      old.destroy(true);
    }
  }, [showPlaces, base]);

  const d = ticksQ.data;
  const startIdx = useMemo(() => {
    if (!d) return 0;
    const fe = d.freeze_end_tick ?? d.ticks[0];
    return Math.max(0, d.ticks.findIndex((t) => t >= fe));
  }, [d]);

  useEffect(() => {
    if (!d || !base || !stageRef.current) return;
    let destroyed = false;
    const app = new Application();
    const el = stageRef.current;

    (async () => {
      // resolution + autoDensity: Retina'da metin/çizgiler net (fiziksel 2×)
      await app.init({
        width: W, height: W, background: 0x0b0e0c, antialias: true,
        resolution: DPR, autoDensity: true,
      });
      if (destroyed) { app.destroy(true); return; }
      el.innerHTML = '';
      el.appendChild(app.canvas);
      app.canvas.className = 'flat';

      const px = (v: number) => (v * W) / RADAR;
      const worldPx = (u: number) => px(u / d.radar.scale);

      // arka plan tuvali fiziksel çözünürlükte üretilir, sprite CSS boyutuna oturur
      const baseSprite = new Sprite(
        Texture.from(renderMapBaseCanvas(base, W * DPR * (isVectorBase(base) ? VECTOR_OVERSAMPLE : BASE_OVERSAMPLE), showPlaces, 'upper')),
      );
      baseSprite.setSize(W, W);
      baseSpriteRef.current = baseSprite;
      // Çok katlı haritada alt kat: sağ üstte sabit mini harita (turnuva stili)
      const hasLower = d.radar.has_lower;
      const ig = insetGeom(W);                  // paylaşılan geometri (çerçevesiz)
      const INS = ig.size;
      const IX = ig.x, IY = ig.y;
      const gNades = new Graphics();
      const gKills = new Graphics();
      const gGhosts = new Graphics();     // hayalet izler (diğer rauntlar)
      const heatSprite = new Sprite(Texture.EMPTY); // ısı katmanı (zemin üstü)
      heatSprite.visible = false;
      const playersLayer = new Container();
      // world: zoom/pan uygulanan tüm harita içeriği; feedLayer ekran sabiti
      const world = new Container();
      const worldLabels = new Container(); // bomba/hayalet etiketleri (zoom'la ölçeklenir)
      const feedLayer = new Container();   // canvas içi killfeed (gri, sabit)
      world.addChild(baseSprite);
      if (hasLower) {
        const insetSprite = new Sprite(Texture.from(renderMapBaseCanvas(base, INS * DPR * (isVectorBase(base) ? VECTOR_OVERSAMPLE : BASE_OVERSAMPLE), false, 'lower')));
        insetSprite.setSize(INS, INS);
        insetSprite.position.set(IX, IY);
        const tag = new Text({
          text: 'LOWER',
          style: { fontSize: 9, fill: 0x9fc79f, fontFamily: 'system-ui' },
        });
        tag.position.set(IX + 4, IY + INS - 14);
        world.addChild(insetSprite, tag);
      }
      world.addChild(heatSprite, gGhosts, gNades, gKills, playersLayer, worldLabels);
      app.stage.addChild(world, feedLayer);

      // --- Zoom & pan: tekerlek imlece doğru yakınlaşır, sürükle kaydırır,
      //     çift tık sıfırlar. Killfeed ve HUD ekranda sabit kalır. ---
      const view = { s: 1, x: 0, y: 0 };
      const clampView = () => {
        view.s = Math.min(8, Math.max(1, view.s));
        const min = W - W * view.s;
        view.x = Math.min(0, Math.max(min, view.x));
        view.y = Math.min(0, Math.max(min, view.y));
        world.scale.set(view.s);
        world.position.set(view.x, view.y);
        app.canvas.style.cursor = view.s > 1 ? 'grab' : 'default';
      };
      const zoomAt = (mx: number, my: number, factor: number) => {
        const ns = Math.min(8, Math.max(1, view.s * factor));
        // odak altındaki dünya noktası sabit kalsın
        view.x = mx - ((mx - view.x) / view.s) * ns;
        view.y = my - ((my - view.y) / view.s) * ns;
        view.s = ns;
        clampView();
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = app.canvas.getBoundingClientRect();
        // Mac trackpad pinch'i ctrlKey'li wheel olarak gelir; küçük deltalarla
        // çalıştığı için daha güçlü çarpan gerekir
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022));
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      };
      // Safari trackpad pinch: gesture* olayları (e.scale mutlak ölçek)
      let gestureBase = 1;
      const onGestureStart = (e: Event) => { e.preventDefault(); gestureBase = view.s; };
      const onGestureChange = (e: Event) => {
        e.preventDefault();
        const ge = e as unknown as { scale: number; clientX: number; clientY: number };
        const rect = app.canvas.getBoundingClientRect();
        const target = Math.min(8, Math.max(1, gestureBase * ge.scale));
        zoomAt(ge.clientX - rect.left, ge.clientY - rect.top, target / view.s);
      };
      zoomApiRef.current = {
        zoomIn: () => zoomAt(W / 2, W / 2, 1.4),
        zoomOut: () => zoomAt(W / 2, W / 2, 1 / 1.4),
        reset: () => { view.s = 1; view.x = 0; view.y = 0; clampView(); },
      };
      let panning = false;
      let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
      const onDown = (e: PointerEvent) => {
        if (view.s <= 1) return;
        panning = true;
        panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        app.canvas.setPointerCapture(e.pointerId);
        app.canvas.style.cursor = 'grabbing';
      };
      const onMove = (e: PointerEvent) => {
        if (!panning) return;
        view.x = panStart.vx + (e.clientX - panStart.x);
        view.y = panStart.vy + (e.clientY - panStart.y);
        clampView();
      };
      const onUp = () => {
        panning = false;
        app.canvas.style.cursor = view.s > 1 ? 'grab' : 'default';
      };
      const onDbl = () => { view.s = 1; view.x = 0; view.y = 0; clampView(); };
      app.canvas.addEventListener('wheel', onWheel, { passive: false });
      app.canvas.addEventListener('pointerdown', onDown);
      app.canvas.addEventListener('pointermove', onMove);
      app.canvas.addEventListener('pointerup', onUp);
      app.canvas.addEventListener('pointercancel', onUp);
      app.canvas.addEventListener('dblclick', onDbl);
      app.canvas.addEventListener('gesturestart', onGestureStart);
      app.canvas.addEventListener('gesturechange', onGestureChange);

      // hayalet raunt etiketleri (r7 gibi) — yeniden kullanılan havuz
      const ghostLabels: Text[] = [];
      for (let i = 0; i < 12; i++) {
        const t = new Text({
          text: '',
          style: { fontSize: 10, fontWeight: '700', fill: 0xffffff, fontFamily: 'system-ui' },
        });
        t.visible = false;
        worldLabels.addChild(t);
        ghostLabels.push(t);
      }
      let appliedHeat: HTMLCanvasElement | null = null;

      // Konum eşleme: nesne kendi katının görünümüne çizilir.
      // s = boyut ölçeği (inset'te her şey küçülür).
      const place = (rx: number, ry: number, lower: boolean | null | undefined) => {
        if (hasLower && lower) {
          return { x: IX + (rx * INS) / RADAR, y: IY + (ry * INS) / RADAR, s: INS / W };
        }
        return { x: (rx * W) / RADAR, y: (ry * W) / RADAR, s: 1 };
      };

      // Bomba tip etiketleri: yeniden kullanılan Text havuzu (Graphics yazı çizemez)
      const nadeLabelPool: Text[] = [];
      for (let i = 0; i < 24; i++) {
        const t = new Text({
          text: '',
          style: { fontSize: 9, fill: 0xdde4de, fontFamily: 'system-ui', fontWeight: '600' },
        });
        t.anchor.set(0.5, 1);
        t.visible = false;
        worldLabels.addChild(t); // dünya uzayında: zoom'la birlikte hareket eder
        nadeLabelPool.push(t);
      }
      const NADE_LABEL: Record<string, string> = {
        smoke: 'SMOKE', molotov: 'FIRE', incendiary: 'FIRE',
        flash: 'FLASH', he: 'HE', decoy: 'DECOY',
      };
      const NADE_COLOR: Record<string, number> = {
        smoke: 0xb4b9be, molotov: 0xeb781e, incendiary: 0xeb781e,
        flash: 0xffffff, he: 0xff8c3c, decoy: 0xc8c878,
      };

      const feedTexts: Text[] = [];
      const feedX = hasLower ? IX - 12 : W - 10; // inset varsa onun soluna
      for (let i = 0; i < 6; i++) {
        const t = new Text({
          text: '',
          style: { fontSize: 12, fill: 0xb9c2bb, fontFamily: 'system-ui' },
        });
        t.anchor.set(1, 0);
        t.position.set(feedX, 10 + i * 17);
        feedLayer.addChild(t);
        feedTexts.push(t);
      }

      type PlayerNode = { g: Graphics; name: Text };
      const nodes: PlayerNode[] = d.players.map((p) => {
        const g = new Graphics();
        // tıklanabilir: zaman çubuğu bu oyuncunun olaylarına odaklanır
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.on('pointertap', () => {
          setSelPlayer((cur) => (cur === p.nickname ? '' : p.nickname));
        });
        const name = new Text({
          text: p.nickname,
          style: { fontSize: 11, fill: 0xcfd8d0, fontFamily: 'system-ui' },
        });
        playersLayer.addChild(g, name);
        return { g, name };
      });

      let init = startIdx;
      if (seekTick != null) {
        const i = d.ticks.findIndex((t) => t >= seekTick);
        if (i >= 0) init = i;
      }
      fIdxRef.current = init;

      let lastHud = -1;
      const draw = () => {
        const fIdx = fIdxRef.current;
        const i0 = Math.min(Math.floor(fIdx), d.ticks.length - 1);
        const i1 = Math.min(i0 + 1, d.ticks.length - 1);
        const frac = fIdx - i0;
        const tick = d.ticks[i0] + (d.ticks[i1] - d.ticks[i0]) * frac;

        // --- ısı katmanı: hazır tuvali tembelce dokuya çevir ---
        if (appliedHeat !== heatCanvasRef.current) {
          appliedHeat = heatCanvasRef.current;
          const old = heatSprite.texture;
          if (appliedHeat) {
            heatSprite.texture = Texture.from(appliedHeat);
            heatSprite.setSize(W, W);
            heatSprite.visible = true;
          } else {
            heatSprite.texture = Texture.EMPTY;
            heatSprite.visible = false;
          }
          if (old !== Texture.EMPTY) old.destroy(true);
        }

        // --- hayalet izler: KENDİ saatiyle oynar (replay'den bağımsız) ---
        gGhosts.clear();
        let ghostLabelIdx = 0;
        const gd = ghostsOnRef.current ? ghostDataRef.current : null;
        if (gd) {
          const tSec = ghostTimeRef.current;
          gd.layers.forEach((ly, li) => {
            if (ly.skipped || !ly.players) return;
            const hue = ghostHue(li);
            const col = hslToRgbHex(hue, 0.7, 0.6);
            let labeled = false;
            for (const p of ly.players) {
              if (ghostPlayerRef.current && p.nick !== ghostPlayerRef.current) continue;
              const from = lowerBound(p.t, tSec - GHOST_TRAIL);
              let started = false;
              let prevLower: boolean | undefined;
              let lastX = 0, lastY = 0, lastS = 1, seen = false;
              for (let i = from; i < p.t.length && p.t[i] <= tSec; i++) {
                const lo = p.lower?.[i] ?? false;
                const { x, y, s } = place(p.rx[i], p.ry[i], lo);
                if (!started || lo !== prevLower) gGhosts.moveTo(x, y);
                else gGhosts.lineTo(x, y);
                started = true;
                prevLower = lo;
                lastX = x; lastY = y; lastS = s; seen = true;
              }
              if (started) gGhosts.stroke({ width: 1.5, color: col, alpha: 0.4 });
              if (seen) {
                gGhosts.circle(lastX, lastY, 4 * Math.max(lastS, 0.7))
                  .fill({ color: col, alpha: 0.8 })
                  .stroke({ width: 1, color: 0x0b0e0c, alpha: 0.8 });
                if (!labeled && ghostLabelIdx < ghostLabels.length) {
                  const lt = ghostLabels[ghostLabelIdx++];
                  lt.text = `r${ly.round_number}`;
                  lt.style.fill = col;
                  lt.visible = true;
                  lt.position.set(lastX + 7, lastY - 12);
                  labeled = true;
                }
              }
            }
          });
        }
        for (let i = ghostLabelIdx; i < ghostLabels.length; i++) ghostLabels[i].visible = false;

        const replayOn = replayOnRef.current;
        playersLayer.visible = replayOn;

        gNades.clear();
        let labelIdx = 0;
        const nadeLabel = (x: number, y: number, offY: number, g: { type: string }, alpha: number, s: number) => {
          if (labelIdx >= nadeLabelPool.length) return;
          const t = nadeLabelPool[labelIdx++];
          t.text = NADE_LABEL[g.type] ?? g.type.toUpperCase();
          t.visible = true;
          t.alpha = alpha;
          t.scale.set(Math.max(s, 0.75));
          t.position.set(x, y - offY);
        };
        const phase = (tick / d.tick_rate) % 1; // hafif titreşim için zaman fazı

        for (const g of replayOn ? (d.grenades ?? []) : []) {
          if (g.rx == null || g.ry == null) continue;
          const dt = (tick - g.tick) / d.tick_rate;
          const life = NADE_LIFE[g.type] ?? 1;

          // Uçuş animasyonu: atıştan patlamaya küçük nokta + kesikli iz
          // (baskın olmasın: 2 px nokta, %35 iz)
          if (g.throw_tick != null && g.throw_rx != null && g.throw_ry != null &&
              tick >= g.throw_tick && tick < g.tick && g.tick > g.throw_tick) {
            const p = (tick - g.throw_tick) / (g.tick - g.throw_tick);
            const from = place(g.throw_rx, g.throw_ry, g.throw_lower);
            const to = place(g.rx, g.ry, g.lower);
            if ((g.throw_lower ?? false) === (g.lower ?? false)) { // aynı kat görünümünde
              const fx = from.x + (to.x - from.x) * p;
              const fy = from.y + (to.y - from.y) * p - Math.sin(Math.PI * p) * 9 * to.s;
              gNades.moveTo(from.x, from.y).lineTo(fx, fy)
                .stroke({ width: 1, color: NADE_COLOR[g.type] ?? 0xffffff, alpha: 0.22 });
              gNades.circle(fx, fy, 2.2 * to.s)
                .fill({ color: NADE_COLOR[g.type] ?? 0xffffff, alpha: 0.85 });
            }
            continue;
          }

          if (dt < 0 || dt > life) continue;
          const { x, y, s } = place(g.rx, g.ry, g.lower);
          const fade = Math.min(1, (life - dt) / 2);
          if (g.type === 'smoke') {
            const r = worldPx(144) * s;
            gNades.circle(x, y, r).fill({ color: 0xb4b9be, alpha: 0.4 * fade });
            gNades.circle(x, y, r).stroke({ width: 1, color: 0xd8dde0, alpha: 0.5 * fade });
            nadeLabel(x, y, r + 3, g, 0.65 * fade, s);
          } else if (g.type === 'molotov' || g.type === 'incendiary') {
            const r = worldPx(120) * s;
            const flick = 1 + 0.08 * Math.sin(phase * Math.PI * 4); // hafif alev titremesi
            gNades.circle(x, y, r).fill({ color: 0xeb781e, alpha: 0.35 * fade });
            gNades.circle(x, y, r * 0.55 * flick).fill({ color: 0xf5a83c, alpha: 0.4 * fade });
            nadeLabel(x, y, r + 3, g, 0.65 * fade, s);
          } else if (g.type === 'flash') {
            const k = dt / life;
            const r = (4 + 14 * k) * s;
            gNades.circle(x, y, r).fill({ color: 0xffffff, alpha: 0.9 * (1 - k) });
            // 4 kısa ışın: flash'ı HE'den ayırır
            for (let a = 0; a < 4; a++) {
              const ang = (Math.PI / 2) * a + Math.PI / 4;
              gNades.moveTo(x + r * Math.cos(ang), y + r * Math.sin(ang))
                .lineTo(x + (r + 6 * s) * Math.cos(ang), y + (r + 6 * s) * Math.sin(ang))
                .stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 * (1 - k) });
            }
            nadeLabel(x, y, r + 8, g, 0.9 * (1 - k), s);
          } else if (g.type === 'he') {
            const k = dt / life;
            const r = (4 + 12 * k) * s;
            gNades.circle(x, y, r).fill({ color: 0xff8c3c, alpha: 0.8 * (1 - k) });
            gNades.circle(x, y, r + 3 * s).stroke({ width: 1.5, color: 0xd94f2a, alpha: 0.7 * (1 - k) });
            nadeLabel(x, y, r + 8, g, 0.9 * (1 - k), s);
          } else if (g.type === 'decoy') {
            gNades.circle(x, y, 5 * s).stroke({ width: 1, color: 0xc8c878, alpha: 0.5 * fade });
            nadeLabel(x, y, 9, g, 0.5 * fade, s);
          }
        }
        for (let i = labelIdx; i < nadeLabelPool.length; i++) nadeLabelPool[i].visible = false;

        gKills.clear();
        for (const k of replayOn ? d.kills : []) {
          if (k.victim_rx == null || k.victim_ry == null) continue;
          if (tick >= k.tick && tick - k.tick < 3 * d.tick_rate) {
            const { x, y, s } = place(k.victim_rx, k.victim_ry, k.lower);
            gKills.circle(x, y, 11 * s).stroke({ width: 2, color: 0xe05545, alpha: 0.8 });
          }
        }

        d.players.forEach((p, pi) => {
          const node = nodes[pi];
          const rx0 = p.rx[i0], ry0 = p.ry[i0];
          if (rx0 == null || ry0 == null) {
            node.g.clear(); node.name.visible = false;
            return;
          }
          const rx1 = p.rx[i1] ?? rx0, ry1 = p.ry[i1] ?? ry0;
          const lower = p.lower ? (p.lower[i0] ?? false) : false;
          const { x, y, s } = place(
            rx0 + (rx1 - rx0) * frac,
            ry0 + (ry1 - ry0) * frac,
            lower,
          );
          const alive = p.alive[i0] ?? false;
          const col = SIDE_COLOR[p.side] ?? 0x999999;
          const g = node.g;
          g.clear();
          node.name.visible = namesRef.current && alive;
          node.name.scale.set(Math.max(s, 0.72)); // inset'te küçük ama okunur

          if (!alive) {
            g.moveTo(x - 4 * s, y - 4 * s).lineTo(x + 4 * s, y + 4 * s)
             .moveTo(x + 4 * s, y - 4 * s).lineTo(x - 4 * s, y + 4 * s)
             .stroke({ width: 1.5, color: 0xaaaaaa, alpha: 0.55 });
            node.name.visible = false;
            return;
          }
          const yaw = ((p.yaw[i0] ?? 0) * Math.PI) / 180;
          g.moveTo(x, y).lineTo(x + 15 * s * Math.cos(yaw), y - 15 * s * Math.sin(yaw))
           .stroke({ width: 1.5, color: col });
          // ateş animasyonu: namlu parıltısı + kırmızı mermi izi (tracer).
          // Atış bir kill'e denk geliyorsa iz kurbana kadar, değilse bakış
          // yönünde tipik menzil kadar çizilir; ~0.12 sn'de söner.
          if (p.shots.length) {
            const si = lowerBound(p.shots, tick - 8);
            if (si < p.shots.length && p.shots[si] <= tick) {
              const shotTick = p.shots[si];
              const age = (tick - shotTick) / 8; // 0..1
              const fade = 1 - age;
              const mx0 = x + 15 * s * Math.cos(yaw), my0 = y - 15 * s * Math.sin(yaw);
              // kill eşleşmesi: aynı anda (±4 tick) bu oyuncunun kill'i var mı
              let ex = mx0 + worldPx(750) * s * Math.cos(yaw);
              let ey = my0 - worldPx(750) * s * Math.sin(yaw);
              for (const k of d.kills) {
                if (k.attacker === p.nickname && Math.abs(k.tick - shotTick) <= 4
                    && k.victim_rx != null && k.victim_ry != null) {
                  const vp = place(k.victim_rx, k.victim_ry, k.lower);
                  ex = vp.x; ey = vp.y;
                  break;
                }
              }
              g.moveTo(mx0, my0).lineTo(ex, ey)
               .stroke({ width: 1, color: 0xe05545, alpha: 0.55 * fade });
              g.moveTo(mx0, my0)
               .lineTo(mx0 + 6 * s * Math.cos(yaw), my0 - 6 * s * Math.sin(yaw))
               .stroke({ width: 2, color: 0xffe9a8, alpha: 0.85 * fade });
              g.circle(mx0, my0, 1.8 * s).fill({ color: 0xfff6d8, alpha: 0.9 * fade });
            }
          }
          g.circle(x, y, 5.5 * Math.max(s, 0.7)).fill({ color: col })
           .stroke({ width: 1, color: 0x0b0e0c });
          // can halkası — yay başlangıcına moveTo: aksi halde yol (0,0)'dan
          // bağlanıp sol üstten gelen hayalet çizgi oluşturuyordu
          const hp = p.hp[i0] ?? 0;
          if (hp > 0) {
            const r = 8.5 * Math.max(s, 0.7);
            const a0 = -Math.PI / 2;
            const a1 = a0 + (2 * Math.PI * hp) / 100;
            g.moveTo(x + r * Math.cos(a0), y + r * Math.sin(a0));
            g.arc(x, y, r, a0, a1);
            g.stroke({ width: 2, color: hslToHex(Math.round((120 * hp) / 100), 0.75, 0.5) });
          }
          const fl = p.flash[i0] ?? 0;
          if (fl > 0.2) {
            g.circle(x, y, 12 * Math.max(s, 0.7))
             .stroke({ width: 3, color: 0xffffff, alpha: Math.min(0.9, fl / 3) });
          }
          // seçili oyuncu vurgusu (zaman çubuğu onu takip ediyor)
          if (p.nickname === selPlayerRef.current) {
            g.circle(x, y, 14 * Math.max(s, 0.7))
             .stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
          }
          node.name.position.set(x + 10 * Math.max(s, 0.72), y - 5 * Math.max(s, 0.72));
        });

        if (i0 !== lastHud) {
          lastHud = i0;
          const fe = d.freeze_end_tick ?? d.ticks[startIdx];
          const s = Math.max(0, (d.ticks[i0] - fe) / d.tick_rate);
          setClock(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

          // canvas içi killfeed (son 6 sn; replay katmanı kapalıysa boş)
          const recent = replayOn
            ? d.kills.filter((k) => tick >= k.tick && tick - k.tick < 6 * d.tick_rate).slice(-6)
            : [];
          feedTexts.forEach((t, i) => {
            const k = recent[i];
            t.text = k ? `${k.attacker ?? '?'} ⟶ ${k.victim ?? '?'} (${k.weapon ?? ''})` : '';
          });

          // köşe HUD'ları: kümülatif K/A/D maç kill listesinden
          const kad = (nick: string) => {
            let k = 0, a = 0, dd = 0;
            for (const kk of matchKills) {
              const before = kk.round_number < round ||
                (kk.round_number === round && kk.tick <= tick);
              if (!before) continue;
              if (kk.attacker === nick) k++;
              if (kk.assister === nick) a++;
              if (kk.victim === nick) dd++;
            }
            return { k, a, d: dd };
          };
          setHudRows(d.players.map((p) => {
            const { k, a, d: dd } = kad(p.nickname);
            return {
              nick: p.nickname, side: p.side,
              hp: p.hp[i0] ?? 0, armor: p.armor[i0] ?? 0,
              weapon: p.weapon[i0] ?? '',
              money: p.money_start,
              inv: shortInv(p.inv[i0]),
              k, a, d: dd,
              alive: p.alive[i0] ?? false,
            };
          }));
          if (sliderRef.current) sliderRef.current.value = String(i0);
        }
      };

      let lastGhostSec = -1;
      app.ticker.add((t) => {
        if (playingRef.current) {
          fIdxRef.current = Math.min(
            fIdxRef.current + (t.deltaMS / 1000) * 16 * speedRef.current,
            d.ticks.length - 1,
          );
          if (fIdxRef.current >= d.ticks.length - 1) setPlaying(false);
        }
        // hayalet saati: kendi oynatması, kendi hız çarpanı (0..115 sn)
        if (ghostPlayingRef.current) {
          ghostTimeRef.current = Math.min(
            ghostTimeRef.current + (t.deltaMS / 1000) * ghostSpeedRef.current, 115);
          if (ghostTimeRef.current >= 115) setGhostPlaying(false);
        }
        const gs = Math.floor(ghostTimeRef.current);
        if (gs !== lastGhostSec) {
          lastGhostSec = gs;
          setGhostClock(`${Math.floor(gs / 60)}:${String(gs % 60).padStart(2, '0')}`);
          if (ghostSliderRef.current) ghostSliderRef.current.value = String(gs);
        }
        draw();
      });
      draw();
    })();

    return () => {
      destroyed = true;
      baseSpriteRef.current = null;
      zoomApiRef.current = null;
      try { app.destroy(true, { children: true }); } catch { /* init yarıda */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, base, matchKills]);

  if (ticksQ.isLoading) return <p className="meta">loading round…</p>;
  if (ticksQ.error || !d) return <p className="error">{String(ticksQ.error)}</p>;

  const tRows = hudRows.filter((r) => r.side === 'T');
  const ctRows = hudRows.filter((r) => r.side === 'CT');

  // Zaman çubuğu işaretleri: seçim yoksa tüm kill'ler; oyuncu seçiliyse onun
  // kill (yeşil) / ölüm (kırmızı) / bomba atışları (tip renginde).
  const NADE_MARK: Record<string, string> = {
    smoke: '#b4b9be', molotov: '#eb781e', incendiary: '#eb781e',
    flash: '#ffffff', he: '#ff8c3c', decoy: '#c8c878',
  };
  const timelineMarks = !d ? [] : !selPlayer
    ? d.kills.map((k) => ({
        tick: k.tick, color: '#e05545',
        title: `${k.attacker ?? '?'} ⟶ ${k.victim ?? '?'}`,
      }))
    : [
        ...d.kills.filter((k) => k.attacker === selPlayer).map((k) => ({
          tick: k.tick, color: '#7fd88f', title: `kill: ${k.victim} (${k.weapon ?? ''})`,
        })),
        ...d.kills.filter((k) => k.victim === selPlayer).map((k) => ({
          tick: k.tick, color: '#e05545', title: `death: by ${k.attacker ?? '?'}`,
        })),
        ...(d.grenades ?? [])
          .filter((g) => g.thrower === selPlayer && g.throw_tick != null)
          .map((g) => ({
            tick: g.throw_tick as number,
            color: NADE_MARK[g.type] ?? '#ccc',
            title: `${g.type} thrown`,
          })),
      ];

  return (
    <div className="replaylayout">
      {/* Sol: harita tam boy; HUD'lar köşe kaplaması — kompakt, hover'da detay */}
      <div>
        <div className="stagebox">
          <div ref={stageRef} />
          <div className="zoombtns noprint">
            <button title="zoom in" onClick={() => zoomApiRef.current?.zoomIn()}>+</button>
            <button title="zoom out" onClick={() => zoomApiRef.current?.zoomOut()}>−</button>
            <button title="reset view" onClick={() => zoomApiRef.current?.reset()}>⟲</button>
          </div>
          {showReplay && <HudPanel rows={tRows} cls="left" sel={selPlayer} onSel={setSelPlayer} />}
          {showReplay && <HudPanel rows={ctRows} cls="right" sel={selPlayer} onSel={setSelPlayer} />}
        </div>
      </div>

      {/* Sağ: başlık + ortak görünüm ayarları + üç katman + zaman çubuğu.
          Tik kaldırılınca bölüm collapse olmaz, grileşir. */}
      <div className="settingspanel">
        {header}
        <div className="layerpanel">
          <div className="layerbody" style={{ marginTop: 0 }}>
            <div className="row">
              <label style={{ minWidth: 0 }}>display</label>
              <label>
                <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} /> player names
              </label>
              <label>
                <input type="checkbox" checked={showPlaces} onChange={(e) => setShowPlaces(e.target.checked)} /> map callouts
              </label>
            </div>
            <p className="meta" style={{ margin: 0 }}>
              scroll on the map to zoom · drag to pan · double-click to reset
            </p>
          </div>
        </div>

        <div className="layerpanel">
          <label className="layerhead">
            <input type="checkbox" checked={showReplay} onChange={(e) => setShowReplay(e.target.checked)} />
            Replay
          </label>
          <div className={`layerbody ${showReplay ? '' : 'dim'}`}>
            <div className="row">
              <button onClick={() => setPlaying(!playing)}>{playing ? '⏸' : '▶'}</button>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {[0.25, 0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              <span className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
            </div>
            <div className="chiplegend" style={{ marginBottom: 2 }}>
              <span><i style={{ background: '#86d8e8' }} />{teams.a ?? 'Team A'}</span>
              <span><i style={{ background: '#dcaaea' }} />{teams.b ?? 'Team B'}</span>
              <span><span className="sideT" />T</span>
              <span><span className="sideCT" />CT</span>
            </div>
            <div className="roundchips">
              {rounds.map((r, i) => (
                <Fragment key={r.round_number}>
                  {isSideSwap(rounds[i - 1], r) && <span className="halfdiv" title="side swap" />}
                  <button
                    className={`${winnerTeamClass(r, teams.aId)} win${r.winner_side ?? ''} ${r.round_number === round ? 'sel' : ''}`}
                    onClick={() => onRound(r.round_number)}
                    title={chipTitle(r, teams)}
                  >
                    {r.round_number}
                  </button>
                </Fragment>
              ))}
            </div>
          </div>
        </div>

        <div className="layerpanel">
          <label className="layerhead">
            <input
              type="checkbox"
              checked={heatOn}
              onChange={(e) => setHeatOn(e.target.checked)}
            />
            Heatmap
            {heatQ.isFetching && <span className="meta"> …</span>}
          </label>
          <div className={`layerbody ${heatOn ? '' : 'dim'}`}>
              <div className="row">
                <label>side</label>
                <select value={heatSide} onChange={(e) => setHeatSide(e.target.value as typeof heatSide)}>
                  <option value="T">T</option><option value="CT">CT</option><option value="both">both</option>
                </select>
                <label>player</label>
                <select value={heatPlayer} onChange={(e) => setHeatPlayer(e.target.value)}>
                  <option value="">all</option>
                  {(players.data ?? []).map((p) => (
                    <option key={p.player_id} value={p.player_id}>{p.nickname}</option>
                  ))}
                </select>
              </div>
              <div className="roundchips">
                {rounds.map((r, i) => (
                  <Fragment key={r.round_number}>
                    {isSideSwap(rounds[i - 1], r) && <span className="halfdiv" title="side swap" />}
                    <button
                      className={`${winnerTeamClass(r, teams.aId)} win${r.winner_side ?? ''} ${heatRounds.has(r.round_number) ? 'sel' : ''}`}
                      title={chipTitle(r, teams)}
                      onClick={() => {
                        const s = new Set(heatRounds);
                        if (s.has(r.round_number)) s.delete(r.round_number);
                        else s.add(r.round_number);
                        setHeatRounds(s);
                      }}
                    >
                      {r.round_number}
                    </button>
                  </Fragment>
                ))}
                <button className="ghost" style={{ width: 'auto', padding: '0 8px' }}
                  onClick={() => setHeatRounds(
                    heatRounds.size === rounds.length
                      ? new Set()
                      : new Set(rounds.map((r) => r.round_number)),
                  )}>
                  {heatRounds.size === rounds.length ? 'none' : 'all'}
                </button>
              </div>
              {heatRounds.size === 0 && <p className="meta">pick rounds to see density</p>}
          </div>
        </div>

        <div className="layerpanel">
          <label className="layerhead">
            <input type="checkbox" checked={ghostsOn} onChange={(e) => setGhostsOn(e.target.checked)} />
            Ghost rounds
            {ghostQ.isFetching && <span className="meta"> …</span>}
          </label>
          <div className={`layerbody ${ghostsOn ? '' : 'dim'}`}>
              {/* hayaletlerin kendi oynatması — replay saatinden bağımsız */}
              <div className="row">
                <button onClick={() => {
                  if (!ghostPlaying && ghostTimeRef.current >= 115) ghostTimeRef.current = 0;
                  setGhostPlaying(!ghostPlaying);
                }}>
                  {ghostPlaying ? '⏸' : '▶'}
                </button>
                <select value={ghostSpeed} onChange={(e) => setGhostSpeed(Number(e.target.value))}>
                  {[0.25, 0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
                </select>
                <span className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>{ghostClock}</span>
              </div>
              <input
                ref={ghostSliderRef}
                type="range" min={0} max={115} step={1} defaultValue={0}
                onInput={(e) => {
                  setGhostPlaying(false);
                  ghostTimeRef.current = Number((e.target as HTMLInputElement).value);
                }}
              />
              <div className="row">
                <label>side</label>
                <select value={ghostSide} onChange={(e) => setGhostSide(e.target.value as typeof ghostSide)}>
                  <option value="T">T</option><option value="CT">CT</option><option value="both">both</option>
                </select>
                <label>player</label>
                <select value={ghostPlayer} onChange={(e) => setGhostPlayer(e.target.value)}>
                  <option value="">all</option>
                  {(players.data ?? []).map((p) => (
                    <option key={p.player_id} value={p.nickname}>{p.nickname}</option>
                  ))}
                </select>
                <button className="ghost" onClick={() => setGhostRounds(new Set())}>clear</button>
              </div>
              <div className="roundchips">
                {rounds.map((r, i) => (
                  <Fragment key={r.round_number}>
                    {isSideSwap(rounds[i - 1], r) && <span className="halfdiv" title="side swap" />}
                    <button
                      className={`${winnerTeamClass(r, teams.aId)} win${r.winner_side ?? ''} ${ghostRounds.has(r.round_number) ? 'sel' : ''}`}
                      title={chipTitle(r, teams)}
                      onClick={() => {
                        const s = new Set(ghostRounds);
                        if (s.has(r.round_number)) s.delete(r.round_number);
                        else if (s.size < 10) s.add(r.round_number);
                        setGhostRounds(s);
                      }}
                    >
                      {r.round_number}
                    </button>
                  </Fragment>
                ))}
              </div>
              <p className="meta">own clock — plays independently of the replay · max 10 rounds</p>
          </div>
        </div>

        {/* Zaman çubuğu: sağ alt (kill/olay işaretli, tıklayınca atlar) */}
        <div className="layerpanel">
          <div className="layerbody" style={{ marginTop: 0 }}>
            <div className="timeline" style={{ width: '100%' }}>
              <input
                ref={sliderRef}
                type="range"
                min={startIdx}
                max={d.ticks.length - 1}
                defaultValue={startIdx}
                onInput={(e) => { fIdxRef.current = Number((e.target as HTMLInputElement).value); }}
              />
              {timelineMarks.map((m, i) => {
                const idx = d.ticks.findIndex((t) => t >= m.tick);
                const pct = (100 * (idx - startIdx)) / Math.max(1, d.ticks.length - 1 - startIdx);
                return (
                  <div
                    key={i}
                    className="killmark clickable"
                    title={m.title}
                    style={{ left: `${Math.max(0, pct)}%`, background: m.color }}
                    onClick={() => { fIdxRef.current = Math.max(startIdx, idx); }}
                  />
                );
              })}
            </div>
            {selPlayer ? (
              <p className="meta" style={{ marginTop: 2 }}>
                <b>{selPlayer}</b> — <span style={{ color: '#7fd88f' }}>kills</span> ·{' '}
                <span style={{ color: '#e05545' }}>deaths</span> · nade throws · click to jump{' '}
                <button className="ghost" style={{ padding: '0 6px' }} onClick={() => setSelPlayer('')}>✕</button>
              </p>
            ) : (
              <p className="meta" style={{ marginTop: 2 }}>
                all kills — click a player (map or HUD) to focus
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HudPanel({
  rows, cls, sel, onSel,
}: {
  rows: HudRow[];
  cls: string;
  sel: string;
  onSel: (n: string | ((cur: string) => string)) => void;
}) {
  // Kompakt köşe HUD'u: tek satır/oyuncu; hover'da zırh/para/envanter açılır
  return (
    <div className={`hud ${cls}`}>
      <table>
        <colgroup>
          <col style={{ width: '30%' }} />
          <col style={{ width: '25%' }} />
          <col style={{ width: '28%' }} />
          <col style={{ width: '17%' }} />
        </colgroup>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.nick}>
              <tr style={{ opacity: r.alive ? 1 : 0.4 }}>
                <td
                  className={`cut nick ${sel === r.nick ? 'selnick' : ''}`}
                  title="focus timeline on this player"
                  onClick={() => onSel((cur) => (cur === r.nick ? '' : r.nick))}
                >
                  {r.nick}
                </td>
                <td>
                  <span className="hpbar">
                    <i style={{ width: `${r.hp}%`, background: `hsl(${(120 * r.hp) / 100},70%,45%)` }} />
                  </span>{' '}
                  {r.hp}
                </td>
                <td className="cut">{r.alive ? r.weapon : '—'}</td>
                <td>{r.k}/{r.a}/{r.d}</td>
              </tr>
              <tr className="detail" style={{ opacity: r.alive ? 1 : 0.4 }}>
                <td className="inv">🛡{r.armor} · ${r.money ?? '?'}</td>
                <td colSpan={3} className="inv cut">{r.alive ? r.inv : ''}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (k: number) => {
    const kk = (k + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(kk - 3, Math.min(9 - kk, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
