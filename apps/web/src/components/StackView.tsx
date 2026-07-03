import { useEffect, useRef, useState } from 'react';
import { api, type RoundRow, type StackResp } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';

const HW = 720;
const LAYER_HUES = [30, 200, 120, 280, 0, 60, 170, 320, 90, 240];

// Bu maçın rauntlarını üst üste bindirme (§8.3). Okunabilirlik:
// katman görünürlüğü tek tek açılıp kapanır, güncel nokta yanında raunt
// numarası yazar, izler yarı saydamdır.
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
  const [data, setData] = useState<StackResp | null>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  const [visible, setVisible] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  const cvRef = useRef<HTMLCanvasElement>(null);

  function toggle(n: number) {
    const s = new Set(selected);
    if (s.has(n)) s.delete(n);
    else if (s.size < 10) s.add(n);
    setSelected(s);
  }

  async function load() {
    setErr('');
    const list = [...selected].sort((a, b) => a - b);
    if (!list.length) { setErr('Üstteki çiplerden en az bir raunt seç (en fazla 10).'); return; }
    try {
      const resp = await api.stack({
        rounds: list.map((n) => ({ match_id: matchId, round_number: n })),
        align,
        side: side || undefined,
      });
      setData(resp);
      setVisible(new Set(resp.layers.filter((l) => !l.skipped).map((l) => l.round_number)));
      setBase(await loadMapBase(resp.map_name));
    } catch (e) { setErr(String(e)); }
  }

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !data || !base) return;
    const ctx = hidpiCtx(cv, HW);
    drawMapBase(ctx, HW, base, true);
    data.layers.forEach((ly, li) => {
      if (ly.skipped || !ly.players || !visible.has(ly.round_number)) return;
      const hue = LAYER_HUES[li % 10];
      let labelDrawn = false;
      for (const p of ly.players) {
        ctx.strokeStyle = `hsla(${hue},70%,60%,0.35)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false, last = -1;
        for (let i = 0; i < p.t.length; i++) {
          if (p.t[i] < tNow - trail || p.t[i] > tNow) continue;
          const x = (p.rx[i] * HW) / RADAR, y = (p.ry[i] * HW) / RADAR;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          last = i;
        }
        ctx.stroke();
        if (last >= 0) {
          const x = (p.rx[last] * HW) / RADAR, y = (p.ry[last] * HW) / RADAR;
          ctx.fillStyle = `hsl(${hue},70%,60%)`;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
          ctx.strokeStyle = '#0b0e0c'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.stroke();
          if (!labelDrawn) {   // katman başına bir kez raunt numarası
            ctx.fillStyle = `hsl(${hue},70%,70%)`;
            ctx.font = 'bold 11px system-ui';
            ctx.fillText(`r${ly.round_number}`, x + 8, y - 6);
            labelDrawn = true;
          }
        }
      }
    });
    ctx.fillStyle = '#9aa39c'; ctx.font = '11px system-ui';
    ctx.fillText(`t = ${tNow.toFixed(1)} sn (${data.align})`, 8, 14);
  }, [data, base, tNow, trail, visible]);

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
            <label>t = {tNow.toFixed(1)} sn</label>
            <input type="range" min={-40} max={40} step={0.5} value={tNow}
              onChange={(e) => setTNow(Number(e.target.value))} style={{ width: 240 }} />
            <label>iz: {trail} sn</label>
            <input type="range" min={2} max={30} value={trail}
              onChange={(e) => setTrail(Number(e.target.value))} style={{ width: 110 }} />
            {data.layers.filter((l) => !l.skipped).map((l, i) => (
              <label key={l.round_number} style={{ color: `hsl(${LAYER_HUES[i % 10]},70%,60%)` }}>
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
