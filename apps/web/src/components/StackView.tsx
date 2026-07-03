import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type RoundRow, type StackResp } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';

const HW = 720;
const MAX_ROUNDS = 30;
// altın açı: kaç katman olursa olsun ayrışan tonlar
const hue = (i: number) => Math.round((i * 137.508) % 360);

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

export default function StackView({
  matchId, rounds,
}: {
  matchId: string;
  rounds: RoundRow[];
}) {
  const [align, setAlign] = useState('bomb_plant');
  const [side, setSide] = useState('T');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tNow, setTNow] = useState(0);
  const [trail, setTrail] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [playerFilter, setPlayerFilter] = useState('');
  const [data, setData] = useState<StackResp | null>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  const [visible, setVisible] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  const cvRef = useRef<HTMLCanvasElement>(null);

  // zaman aralığı veriden (round_start'ta 0..115, bomb_plant'ta -90..+45 gibi)
  const [tMin, tMax] = useMemo(() => {
    if (!data) return [-40, 40];
    let lo = Infinity, hi = -Infinity;
    for (const ly of data.layers) {
      for (const p of ly.players ?? []) {
        if (p.t.length) {
          lo = Math.min(lo, p.t[0]);
          hi = Math.max(hi, p.t[p.t.length - 1]);
        }
      }
    }
    // devre arası duraklamaları aralığı şişirmesin: en erken -15 sn
    return lo < hi ? [Math.max(Math.floor(lo), -15), Math.min(Math.ceil(hi), 130)] : [-40, 40];
  }, [data]);

  const nicks = useMemo(() => {
    const s = new Set<string>();
    for (const ly of data?.layers ?? []) {
      for (const p of ly.players ?? []) if (p.nick) s.add(p.nick);
    }
    return [...s].sort();
  }, [data]);

  function toggle(n: number) {
    const s = new Set(selected);
    if (s.has(n)) s.delete(n);
    else if (s.size < MAX_ROUNDS) s.add(n);
    setSelected(s);
  }

  async function load() {
    setErr('');
    setPlaying(false);
    const list = [...selected].sort((a, b) => a - b);
    if (!list.length) { setErr(`Üstteki çiplerden raunt seç (en fazla ${MAX_ROUNDS}). "Tümü" da kullanabilirsin.`); return; }
    try {
      const resp = await api.stack({
        rounds: list.map((n) => ({ match_id: matchId, round_number: n })),
        align,
        side: side || undefined,
      });
      setData(resp);
      setVisible(new Set(resp.layers.filter((l) => !l.skipped).map((l) => l.round_number)));
      setBase(await loadMapBase(resp.map_name));
      setTNow(0);
    } catch (e) { setErr(String(e)); }
  }

  // oynatma: rAF ile tNow ilerler (hız × gerçek zaman)
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTNow((t) => {
        const nt = t + dt * speed;
        if (nt >= tMax) { setPlaying(false); return tMax; }
        return nt;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, tMax]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !data || !base) return;
    const ctx = hidpiCtx(cv, HW);
    drawMapBase(ctx, HW, base, true);
    data.layers.forEach((ly, li) => {
      if (ly.skipped || !ly.players || !visible.has(ly.round_number)) return;
      const h = hue(li);
      let labelDrawn = false;
      for (const p of ly.players) {
        if (playerFilter && p.nick !== playerFilter) continue;
        ctx.strokeStyle = `hsla(${h},70%,60%,0.35)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false, last = -1;
        const from = lowerBound(p.t, tNow - trail);
        for (let i = from; i < p.t.length && p.t[i] <= tNow; i++) {
          const x = (p.rx[i] * HW) / RADAR, y = (p.ry[i] * HW) / RADAR;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          last = i;
        }
        ctx.stroke();
        if (last >= 0) {
          const x = (p.rx[last] * HW) / RADAR, y = (p.ry[last] * HW) / RADAR;
          ctx.fillStyle = `hsl(${h},70%,60%)`;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
          ctx.strokeStyle = '#0b0e0c'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.stroke();
          if (!labelDrawn) {
            ctx.fillStyle = `hsl(${h},70%,70%)`;
            ctx.font = 'bold 11px system-ui';
            ctx.fillText(`r${ly.round_number}`, x + 8, y - 6);
            labelDrawn = true;
          }
        }
      }
    });
    ctx.fillStyle = '#9aa39c'; ctx.font = '11px system-ui';
    ctx.fillText(
      `t = ${tNow.toFixed(1)} sn (${data.align})${playerFilter ? ' · ' + playerFilter : ''}`,
      8, 14,
    );
  }, [data, base, tNow, trail, visible, playerFilter]);

  const okLayers = data?.layers.filter((l) => !l.skipped) ?? [];

  return (
    <>
      <div className="roundchips">
        {rounds.map((r) => (
          <button
            key={r.round_number}
            className={`${r.winner_side ?? ''} ${selected.has(r.round_number) ? 'sel' : ''}`}
            onClick={() => toggle(r.round_number)}
            title={`r${r.round_number}${r.bomb_site ? ' · bomba ' + r.bomb_site : ''}`}
          >
            {r.round_number}
          </button>
        ))}
        <button
          className="ghost"
          style={{ width: 'auto', padding: '0 8px' }}
          onClick={() => setSelected(
            selected.size === Math.min(rounds.length, MAX_ROUNDS)
              ? new Set()
              : new Set(rounds.slice(0, MAX_ROUNDS).map((r) => r.round_number)),
          )}
        >
          Tümü
        </button>
      </div>
      <div className="toolbar">
        <select value={align} onChange={(e) => setAlign(e.target.value)}>
          <option value="round_start">raunt başı</option>
          <option value="bomb_plant">bomba kurulumu</option>
          <option value="first_kill">ilk temas</option>
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="T">T</option><option value="CT">CT</option><option value="">ikisi</option>
        </select>
        <button onClick={load}>Bindir ({selected.size})</button>
        {err && <span className="error">{err}</span>}
        {data && (
          <span className="meta">
            {data.layers.filter((l) => l.skipped).map((l) => `r${l.round_number}: ${l.skipped}`).join(' · ')}
          </span>
        )}
      </div>
      {data && (
        <>
          <div className="toolbar">
            <button onClick={() => {
              if (!playing && tNow >= tMax) setTNow(tMin);
              setPlaying(!playing);
            }}>
              {playing ? '⏸' : '▶'}
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
            <label>t = {tNow.toFixed(1)} sn</label>
            <input type="range" min={tMin} max={tMax} step={0.5} value={tNow}
              onChange={(e) => { setPlaying(false); setTNow(Number(e.target.value)); }}
              style={{ width: 240 }} />
            <label>iz: {trail} sn</label>
            <input type="range" min={2} max={60} value={trail}
              onChange={(e) => setTrail(Number(e.target.value))} style={{ width: 110 }} />
            <select value={playerFilter} onChange={(e) => setPlayerFilter(e.target.value)}>
              <option value="">tüm oyuncular</option>
              {nicks.map((n) => <option key={n}>{n}</option>)}
            </select>
          </div>
          <div className="toolbar" style={{ rowGap: 2 }}>
            {okLayers.map((l, i) => (
              <label key={l.round_number} style={{ color: `hsl(${hue(i)},70%,60%)` }}>
                <input
                  type="checkbox"
                  checked={visible.has(l.round_number)}
                  onChange={() => {
                    const v = new Set(visible);
                    if (v.has(l.round_number)) v.delete(l.round_number);
                    else v.add(l.round_number);
                    setVisible(v);
                  }}
                /> r{l.round_number}
              </label>
            ))}
          </div>
          <canvas ref={cvRef} className="flat" width={HW} height={HW} />
        </>
      )}
    </>
  );
}
