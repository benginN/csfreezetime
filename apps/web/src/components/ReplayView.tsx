import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { api, type KillRow } from '../api';
import { loadMapBase, renderMapBaseCanvas, RADAR, SIDE_COLOR, type MapBase, type MapLevel } from '../lib/mapbase';

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
  const [level, setLevel] = useState<MapLevel>('upper'); // nuke/vertigo katı
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

      const baseSprite = new Sprite(Texture.from(renderMapBaseCanvas(base, W, labels, level)));
      // seçili kat dışındaki nesneler soluk çizilir
      const onLevel = (lower: boolean | null | undefined) =>
        !d.radar.has_lower || lower == null || (level === 'lower') === lower;
      const gNades = new Graphics();
      const gKills = new Graphics();
      const playersLayer = new Container();
      const feedLayer = new Container(); // canvas içi killfeed (sağ üst, gri)
      app.stage.addChild(baseSprite, gNades, gKills, playersLayer, feedLayer);

      const feedTexts: Text[] = [];
      for (let i = 0; i < 6; i++) {
        const t = new Text({
          text: '',
          style: { fontSize: 12, fill: 0xb9c2bb, fontFamily: 'system-ui' },
        });
        t.anchor.set(1, 0);
        t.position.set(W - 10, 10 + i * 17);
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
          if (!onLevel(g.lower)) continue; // diğer kattaki bomba çizilmez
          const dt = (tick - g.tick) / d.tick_rate;
          const life = NADE_LIFE[g.type] ?? 1;
          if (dt < 0 || dt > life) continue;
          const x = px(g.rx), y = px(g.ry);
          const fade = Math.min(1, (life - dt) / 2);
          if (g.type === 'smoke') {
            gNades.circle(x, y, worldPx(144)).fill({ color: 0xb4b9be, alpha: 0.45 * fade });
          } else if (g.type === 'molotov' || g.type === 'incendiary') {
            gNades.circle(x, y, worldPx(120)).fill({ color: 0xeb781e, alpha: 0.4 * fade });
          } else if (g.type === 'flash') {
            const k = dt / life;
            gNades.circle(x, y, 4 + 14 * k).fill({ color: 0xffffff, alpha: 0.9 * (1 - k) });
          } else if (g.type === 'he') {
            const k = dt / life;
            gNades.circle(x, y, 4 + 12 * k).fill({ color: 0xff8c3c, alpha: 0.8 * (1 - k) });
          } else if (g.type === 'decoy') {
            gNades.circle(x, y, 5).stroke({ width: 1, color: 0xc8c878, alpha: 0.5 * fade });
          }
        }

        gKills.clear();
        for (const k of d.kills) {
          if (k.victim_rx == null || k.victim_ry == null) continue;
          if (!onLevel(k.lower)) continue;
          if (tick >= k.tick && tick - k.tick < 3 * d.tick_rate) {
            gKills.circle(px(k.victim_rx), px(k.victim_ry), 11)
              .stroke({ width: 2, color: 0xe05545, alpha: 0.8 });
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
          const x = px(rx0 + (rx1 - rx0) * frac);
          const y = px(ry0 + (ry1 - ry0) * frac);
          const alive = p.alive[i0] ?? false;
          const col = SIDE_COLOR[p.side] ?? 0x999999;
          const g = node.g;
          g.clear();
          node.name.visible = labels && alive;

          if (!alive) {
            g.moveTo(x - 4, y - 4).lineTo(x + 4, y + 4)
             .moveTo(x + 4, y - 4).lineTo(x - 4, y + 4)
             .stroke({ width: 1.5, color: 0xaaaaaa, alpha: 0.55 });
            return;
          }
          const lower = p.lower ? (p.lower[i0] ?? false) : false;
          const yaw = ((p.yaw[i0] ?? 0) * Math.PI) / 180;
          // seçili kattaki oyuncu tam, diğer kattaki hayalet gibi soluk
          const alpha = onLevel(lower) ? 1 : 0.22;
          node.name.visible = labels && alive && onLevel(lower);
          g.moveTo(x, y).lineTo(x + 15 * Math.cos(yaw), y - 15 * Math.sin(yaw))
           .stroke({ width: 1.5, color: col, alpha });
          g.circle(x, y, 5.5).fill({ color: col, alpha })
           .stroke({ width: 1, color: 0x0b0e0c });
          // can halkası — yay başlangıcına moveTo: aksi halde yol (0,0)'dan
          // bağlanıp sol üstten gelen hayalet çizgi oluşturuyordu
          const hp = p.hp[i0] ?? 0;
          if (hp > 0) {
            const a0 = -Math.PI / 2;
            const a1 = a0 + (2 * Math.PI * hp) / 100;
            g.moveTo(x + 8.5 * Math.cos(a0), y + 8.5 * Math.sin(a0));
            g.arc(x, y, 8.5, a0, a1);
            g.stroke({ width: 2, color: hslToHex(Math.round((120 * hp) / 100), 0.75, 0.5), alpha });
          }
          const fl = p.flash[i0] ?? 0;
          if (fl > 0.2) {
            g.circle(x, y, 12).stroke({ width: 3, color: 0xffffff, alpha: Math.min(0.9, fl / 3) });
          }
          node.name.position.set(x + 10, y - 5);
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
  }, [d, base, labels, level, matchKills]);

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
        {d.radar.has_lower && (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button className={level === 'upper' ? '' : 'ghost'} onClick={() => setLevel('upper')}>Üst kat</button>
            <button className={level === 'lower' ? '' : 'ghost'} onClick={() => setLevel('lower')}>Alt kat</button>
          </span>
        )}
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
