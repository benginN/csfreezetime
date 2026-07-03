import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { api } from '../api';
import { loadMapBase, renderMapBaseCanvas, RADAR, SIDE_COLOR, SIDE_CSS, type MapBase } from '../lib/mapbase';

const W = 820;
// bomba görsel ömürleri (sn)
const NADE_LIFE: Record<string, number> = { smoke: 20, molotov: 7, incendiary: 7, flash: 0.7, he: 0.7, decoy: 15 };

interface Hud {
  clock: string;
  kills: { a: string; v: string; w: string }[];
  players: { nick: string; side: string; hp: number; weapon: string; alive: boolean }[];
}

export default function Replay() {
  const { id = '', n = '1' } = useParams();
  const [search] = useSearchParams();
  const seekTick = search.get('t') ? Number(search.get('t')) : null;

  const ticksQ = useQuery({
    queryKey: ['ticks', id, n],
    queryFn: () => api.roundTicks(id, Number(n)),
  });
  const [base, setBase] = useState<MapBase | null>(null);
  useEffect(() => {
    if (ticksQ.data) loadMapBase(ticksQ.data.map_name).then(setBase);
  }, [ticksQ.data]);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [labels, setLabels] = useState(true);
  const [hud, setHud] = useState<Hud>({ clock: '0:00', kills: [], players: [] });

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

  // PixiJS sahnesi
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

      // katmanlar: harita → bombalar → kill halkaları → oyuncular
      const baseSprite = new Sprite(Texture.from(renderMapBaseCanvas(base, W, labels)));
      const gNades = new Graphics();
      const gKills = new Graphics();
      const playersLayer = new Container();
      app.stage.addChild(baseSprite, gNades, gKills, playersLayer);

      type PlayerNode = { g: Graphics; name: Text; wep: Text };
      const nodes: PlayerNode[] = d.players.map((p) => {
        const g = new Graphics();
        const name = new Text({
          text: p.nickname,
          style: { fontSize: 11, fill: 0xcfd8d0, fontFamily: 'system-ui' },
        });
        const wep = new Text({
          text: '',
          style: { fontSize: 9, fill: 0xa0aaa2, fontFamily: 'system-ui' },
        });
        playersLayer.addChild(g, name, wep);
        return { g, name, wep };
      });

      // başlangıç konumu: ?t= parametresi veya freeze bitişi
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

        // bombalar
        gNades.clear();
        for (const g of d.grenades ?? []) {
          if (g.rx == null || g.ry == null) continue;
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

        // kill halkaları (3 sn)
        gKills.clear();
        for (const k of d.kills) {
          if (k.victim_rx == null || k.victim_ry == null) continue;
          if (tick >= k.tick && tick - k.tick < 3 * d.tick_rate) {
            gKills.circle(px(k.victim_rx), px(k.victim_ry!), 11)
              .stroke({ width: 2, color: 0xe05545, alpha: 0.8 });
          }
        }

        // oyuncular (i0↔i1 arası lineer interpolasyon — §8.1)
        d.players.forEach((p, pi) => {
          const node = nodes[pi];
          const rx0 = p.rx[i0], ry0 = p.ry[i0];
          if (rx0 == null || ry0 == null) {
            node.g.clear(); node.name.visible = false; node.wep.visible = false;
            return;
          }
          const rx1 = p.rx[i1] ?? rx0, ry1 = p.ry[i1] ?? ry0;
          const x = px(rx0 + (rx1 - rx0) * frac);
          const y = px(ry0 + (ry1 - ry0) * frac);
          const alive = p.alive[i0] ?? false;
          const col = SIDE_COLOR[p.side] ?? 0x999999;
          const g = node.g;
          g.clear();
          node.name.visible = labels;
          node.wep.visible = labels && alive;

          if (!alive) {
            g.moveTo(x - 4, y - 4).lineTo(x + 4, y + 4)
             .moveTo(x + 4, y - 4).lineTo(x - 4, y + 4)
             .stroke({ width: 1.5, color: 0xaaaaaa, alpha: 0.55 });
            node.name.visible = false; node.wep.visible = false;
            return;
          }
          const lower = p.lower ? (p.lower[i0] ?? false) : false;
          const yaw = ((p.yaw[i0] ?? 0) * Math.PI) / 180;
          const alpha = lower ? 0.45 : 1;
          g.moveTo(x, y).lineTo(x + 15 * Math.cos(yaw), y - 15 * Math.sin(yaw))
           .stroke({ width: 1.5, color: col, alpha });
          g.circle(x, y, 5.5).fill({ color: col, alpha })
           .stroke({ width: 1, color: 0x0b0e0c });
          const hp = p.hp[i0] ?? 0;
          const hue = Math.round((120 * hp) / 100);
          g.arc(x, y, 8.5, -Math.PI / 2, -Math.PI / 2 + (2 * Math.PI * hp) / 100)
           .stroke({ width: 2, color: hslToHex(hue, 0.75, 0.5), alpha });
          const fl = p.flash[i0] ?? 0;
          if (fl > 0.2) {
            g.circle(x, y, 12).stroke({ width: 3, color: 0xffffff, alpha: Math.min(0.9, fl / 3) });
          }
          node.name.position.set(x + 10, y - 6);
          node.wep.position.set(x + 10, y + 5);
          node.wep.text = p.weapon[i0] ?? '';
        });

        // HUD (16 Hz'de bir güncelle — React render maliyeti)
        if (i0 !== lastHud) {
          lastHud = i0;
          const fe = d.freeze_end_tick ?? d.ticks[startIdx];
          const s = Math.max(0, (d.ticks[i0] - fe) / d.tick_rate);
          setHud({
            clock: `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
            kills: d.kills
              .filter((k) => tick >= k.tick && tick - k.tick < 6 * d.tick_rate)
              .map((k) => ({ a: k.attacker ?? '?', v: k.victim ?? '?', w: k.weapon ?? '' })),
            players: d.players.map((p) => ({
              nick: p.nickname, side: p.side,
              hp: p.hp[i0] ?? 0, weapon: p.weapon[i0] ?? '',
              alive: p.alive[i0] ?? false,
            })),
          });
          if (sliderRef.current) sliderRef.current.value = String(i0);
        }
      };

      app.ticker.add((t) => {
        if (playingRef.current) {
          // 16 Hz kare → hız çarpanıyla ilerle (deltaMS ms cinsinden)
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
      try { app.destroy(true, { children: true }); } catch { /* init yarıda kesildi */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, base, labels]);

  if (ticksQ.isLoading) return <p className="meta">raunt yükleniyor…</p>;
  if (ticksQ.error || !d) return <p className="error">{String(ticksQ.error)}</p>;

  return (
    <>
      <h1>
        <Link to={`/match/${id}`}>← Maç</Link>{' '}
        <span className="meta">{d.map_name} · raunt {d.round_number}</span>
      </h1>
      <div className="toolbar">
        <button onClick={() => setPlaying(!playing)}>{playing ? '⏸ Durdur' : '▶ Oynat'}</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <span className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>{hud.clock}</span>
        <label>
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> etiketler
        </label>
        <RoundNav id={id} n={Number(n)} total={null} />
      </div>

      <div className="replay-wrap">
        <div className="replay-stage">
          <div ref={stageRef} />
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
        </div>
        <div className="replay-side">
          <h2 style={{ marginTop: 0 }}>Oyuncular</h2>
          <table className="playerlist">
            <tbody>
              {hud.players.map((p) => (
                <tr key={p.nick} style={{ opacity: p.alive ? 1 : 0.4 }}>
                  <td><span style={{ color: SIDE_CSS[p.side] }}>●</span> {p.nick}</td>
                  <td>
                    <span className="hp">
                      <i style={{ width: `${p.hp}%`, background: `hsl(${(120 * p.hp) / 100},70%,45%)` }} />
                    </span>
                  </td>
                  <td className="meta">{p.alive ? p.weapon : 'öldü'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Killfeed</h2>
          <div className="killfeed">
            {hud.kills.length === 0 && <span className="meta">—</span>}
            {hud.kills.map((k, i) => (
              <div key={i}>{k.a} ⟶ {k.v} <span className="meta">({k.w})</span></div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function RoundNav({ id, n }: { id: string; n: number; total: number | null }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <Link to={`/match/${id}/round/${Math.max(1, n - 1)}`}><button className="ghost">◀ r{n - 1}</button></Link>
      <Link to={`/match/${id}/round/${n + 1}`}><button className="ghost">r{n + 1} ▶</button></Link>
    </span>
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
