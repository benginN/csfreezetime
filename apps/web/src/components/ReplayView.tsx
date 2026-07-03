import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { api, type KillRow } from '../api';
import { loadMapBase, renderMapBaseCanvas, RADAR, SIDE_COLOR, type MapBase } from '../lib/mapbase';

const W = 860;
const NADE_LIFE: Record<string, number> = { smoke: 20, molotov: 7, incendiary: 7, flash: 0.7, he: 0.7, decoy: 15 };

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
    .map((w) => w.replace('High Explosive Grenade', 'HE').replace('Incendiary Grenade', 'Molotof'))
    .join(' · ');
}

export default function ReplayView({
  matchId, round, seekTick, matchKills,
}: {
  matchId: string;
  round: number;
  seekTick: number | null;
  matchKills: KillRow[];
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
  const [labels, setLabels] = useState(true);
  const [clock, setClock] = useState('0:00');
  const [hudRows, setHudRows] = useState<HudRow[]>([]);

  const stageRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const fIdxRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(2);
  playingRef.current = playing;
  speedRef.current = speed;

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
      await app.init({ width: W, height: W, background: 0x0b0e0c, antialias: true });
      if (destroyed) { app.destroy(true); return; }
      el.innerHTML = '';
      el.appendChild(app.canvas);
      app.canvas.className = 'flat';

      const px = (v: number) => (v * W) / RADAR;
      const worldPx = (u: number) => px(u / d.radar.scale);

      const baseSprite = new Sprite(Texture.from(renderMapBaseCanvas(base, W, labels, 'upper')));
      // Çok katlı haritada alt kat: sağ üstte sabit mini harita (turnuva stili)
      const hasLower = d.radar.has_lower;
      const INS = Math.round(W * 0.38);         // inset boyutu
      const IX = W - INS - 8, IY = 8;           // inset konumu (sağ üst)
      const gNades = new Graphics();
      const gKills = new Graphics();
      const playersLayer = new Container();
      const feedLayer = new Container(); // canvas içi killfeed (gri)
      app.stage.addChild(baseSprite);
      if (hasLower) {
        const insetSprite = new Sprite(Texture.from(renderMapBaseCanvas(base, INS, false, 'lower')));
        insetSprite.position.set(IX, IY);
        const border = new Graphics()
          .rect(IX - 1, IY - 1, INS + 2, INS + 2)
          .stroke({ width: 1.5, color: 0x3a5f3e });
        const tag = new Text({
          text: 'ALT KAT',
          style: { fontSize: 10, fill: 0x9fc79f, fontFamily: 'system-ui' },
        });
        tag.position.set(IX + 5, IY + INS - 16);
        app.stage.addChild(insetSprite, border, tag);
      }
      app.stage.addChild(gNades, gKills, playersLayer, feedLayer);

      // Konum eşleme: nesne kendi katının görünümüne çizilir.
      // s = boyut ölçeği (inset'te her şey küçülür).
      const place = (rx: number, ry: number, lower: boolean | null | undefined) => {
        if (hasLower && lower) {
          return { x: IX + (rx * INS) / RADAR, y: IY + (ry * INS) / RADAR, s: INS / W };
        }
        return { x: (rx * W) / RADAR, y: (ry * W) / RADAR, s: 1 };
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

        gNades.clear();
        for (const g of d.grenades ?? []) {
          if (g.rx == null || g.ry == null) continue;
          const dt = (tick - g.tick) / d.tick_rate;
          const life = NADE_LIFE[g.type] ?? 1;
          if (dt < 0 || dt > life) continue;
          const { x, y, s } = place(g.rx, g.ry, g.lower);
          const fade = Math.min(1, (life - dt) / 2);
          if (g.type === 'smoke') {
            gNades.circle(x, y, worldPx(144) * s).fill({ color: 0xb4b9be, alpha: 0.45 * fade });
          } else if (g.type === 'molotov' || g.type === 'incendiary') {
            gNades.circle(x, y, worldPx(120) * s).fill({ color: 0xeb781e, alpha: 0.4 * fade });
          } else if (g.type === 'flash') {
            const k = dt / life;
            gNades.circle(x, y, (4 + 14 * k) * s).fill({ color: 0xffffff, alpha: 0.9 * (1 - k) });
          } else if (g.type === 'he') {
            const k = dt / life;
            gNades.circle(x, y, (4 + 12 * k) * s).fill({ color: 0xff8c3c, alpha: 0.8 * (1 - k) });
          } else if (g.type === 'decoy') {
            gNades.circle(x, y, 5 * s).stroke({ width: 1, color: 0xc8c878, alpha: 0.5 * fade });
          }
        }

        gKills.clear();
        for (const k of d.kills) {
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
          node.name.visible = labels && alive;
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
          node.name.position.set(x + 10 * Math.max(s, 0.72), y - 5 * Math.max(s, 0.72));
        });

        if (i0 !== lastHud) {
          lastHud = i0;
          const fe = d.freeze_end_tick ?? d.ticks[startIdx];
          const s = Math.max(0, (d.ticks[i0] - fe) / d.tick_rate);
          setClock(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

          // canvas içi killfeed (son 6 sn)
          const recent = d.kills
            .filter((k) => tick >= k.tick && tick - k.tick < 6 * d.tick_rate)
            .slice(-6);
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

      app.ticker.add((t) => {
        if (playingRef.current) {
          fIdxRef.current = Math.min(
            fIdxRef.current + (t.deltaMS / 1000) * 16 * speedRef.current,
            d.ticks.length - 1,
          );
          if (fIdxRef.current >= d.ticks.length - 1) setPlaying(false);
        }
        draw();
      });
      draw();
    })();

    return () => {
      destroyed = true;
      try { app.destroy(true, { children: true }); } catch { /* init yarıda */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, base, labels, matchKills]);

  if (ticksQ.isLoading) return <p className="meta">raunt yükleniyor…</p>;
  if (ticksQ.error || !d) return <p className="error">{String(ticksQ.error)}</p>;

  const tRows = hudRows.filter((r) => r.side === 'T');
  const ctRows = hudRows.filter((r) => r.side === 'CT');

  return (
    <>
      <div className="toolbar">
        <button onClick={() => setPlaying(!playing)}>{playing ? '⏸' : '▶'}</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <span className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
        <label>
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> etiketler
        </label>
      </div>

      <div className="stagebox">
        <div ref={stageRef} />
        <HudPanel rows={tRows} cls="left" />
        <HudPanel rows={ctRows} cls="right" />
      </div>
      <div className="timeline" style={{ width: W }}>
        <input
          ref={sliderRef}
          type="range"
          min={startIdx}
          max={d.ticks.length - 1}
          defaultValue={startIdx}
          onInput={(e) => { fIdxRef.current = Number((e.target as HTMLInputElement).value); }}
        />
        {d.kills.map((k, i) => {
          const idx = d.ticks.findIndex((t) => t >= k.tick);
          const pct = (100 * (idx - startIdx)) / Math.max(1, d.ticks.length - 1 - startIdx);
          return <div key={i} className="killmark" style={{ left: `${Math.max(0, pct)}%` }} />;
        })}
      </div>
    </>
  );
}

function HudPanel({ rows, cls }: { rows: HudRow[]; cls: string }) {
  return (
    <div className={`hud ${cls}`}>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.nick} style={{ opacity: r.alive ? 1 : 0.45 }}>
              <td style={{ fontWeight: 600 }}>{r.nick}</td>
              <td>
                <span className="hpbar">
                  <i style={{ width: `${r.hp}%`, background: `hsl(${(120 * r.hp) / 100},70%,45%)` }} />
                </span>{' '}
                {r.hp}
              </td>
              <td>🛡{r.armor}</td>
              <td>{r.alive ? r.weapon : '—'}</td>
              <td>${r.money ?? '?'}</td>
              <td>{r.k}/{r.a}/{r.d}</td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr>
              <td colSpan={6} className="inv">
                {rows.map((r) => r.alive && r.inv ? `${r.nick}: ${r.inv}` : null)
                  .filter(Boolean).join('  |  ')}
              </td>
            </tr>
          )}
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
