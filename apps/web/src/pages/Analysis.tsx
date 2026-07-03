import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Clip, type HeatmapResp, type QueryResult, type StackResp } from '../api';
import { drawMapBase, loadMapBase, RADAR, type MapBase } from '../lib/mapbase';

const HW = 640; // analiz kanvas boyutu
const LAYER_HUES = [30, 200, 120, 280, 0, 60, 170, 320, 90, 240];

export default function Analysis() {
  const matches = useQuery({ queryKey: ['matches', ''], queryFn: () => api.matches() });
  const maps = useMemo(
    () => [...new Set((matches.data ?? []).map((m) => m.map_name).filter(Boolean))].sort() as string[],
    [matches.data],
  );

  // ── DSL form durumu ────────────────────────────────────────────────
  const [eventType, setEventType] = useState('kill');
  const [mapName, setMapName] = useState('');
  const [side, setSide] = useState('');
  const [buy, setBuy] = useState('');
  const [weapon, setWeapon] = useState('');
  const [firstKill, setFirstKill] = useState(false);
  const [trade, setTrade] = useState(false);
  const [headshot, setHeadshot] = useState(false);
  const [grenadeType, setGrenadeType] = useState('flash');
  const [firstOfType, setFirstOfType] = useState(true);
  const [bombAction, setBombAction] = useState('plant');
  const [site, setSite] = useState('');
  const [area, setArea] = useState('');
  const [minPlayers, setMinPlayers] = useState(3);
  const [equipMin, setEquipMin] = useState(20000);
  const [tFrom, setTFrom] = useState(''); const [tTo, setTTo] = useState('');

  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState('');
  const clips: Clip[] = result?.clips ?? [];

  // presence bölge listesi seçili haritanın layout'undan
  const [areas, setAreas] = useState<string[]>([]);
  useEffect(() => {
    if (mapName) loadMapBase(mapName).then((b) => setAreas(b.layout.places.map((p) => p.name)));
    else setAreas([]);
  }, [mapName]);

  function buildDsl(): unknown {
    const filters: Record<string, unknown> = {};
    if (mapName) filters.map = mapName;
    if (side) filters.side = side;
    if (buy) filters.buy_type = [buy];
    const ev: Record<string, unknown> = { type: eventType };
    const tw = tFrom !== '' || tTo !== ''
      ? { from: Number(tFrom || 0), to: Number(tTo || 999) } : undefined;
    if (tw) ev.time_window = tw;
    if (eventType === 'kill') {
      if (weapon) ev.weapon = weapon.toLowerCase();
      if (firstKill) ev.first_kill = true;
      if (trade) ev.trade = true;
      if (headshot) ev.headshot = true;
      if (area) ev.area = area;
    } else if (eventType === 'grenade') {
      ev.grenade_type = grenadeType;
      if (firstOfType) ev.order = 'first_of_type_in_round';
    } else if (eventType === 'bomb') {
      ev.bomb_action = bombAction;
      if (site) ev.site = site;
    } else if (eventType === 'presence') {
      ev.area = area;
      ev.min_players = minPlayers;
    } else if (eventType === 'economy') {
      ev.equip_min = equipMin;
    }
    filters.event = ev;
    return { intent: 'find_moments', filters, output: { format: 'clips' } };
  }

  async function run() {
    setErr('');
    try {
      setResult(await api.query(buildDsl()));
    } catch (e) {
      setResult(null);
      setErr(String(e));
    }
  }

  return (
    <>
      <h1>Analiz</h1>

      <div className="split2">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Arama</h2>
          <div className="toolbar">
            <label>Olay</label>
            <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
              <option value="kill">Kill</option>
              <option value="grenade">Bomba (utility)</option>
              <option value="bomb">C4</option>
              <option value="presence">Bölgede oyuncu</option>
              <option value="economy">Ekonomi</option>
            </select>
          </div>
          <div className="toolbar">
            <label>Harita</label>
            <select value={mapName} onChange={(e) => setMapName(e.target.value)}>
              <option value="">tümü</option>
              {maps.map((m) => <option key={m}>{m}</option>)}
            </select>
            <label>Taraf</label>
            <select value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="">ikisi</option><option>T</option><option>CT</option>
            </select>
            <label>Buy</label>
            <select value={buy} onChange={(e) => setBuy(e.target.value)}>
              <option value="">hepsi</option>
              {['pistol', 'eco', 'semi', 'force', 'full'].map((b) => <option key={b}>{b}</option>)}
            </select>
          </div>

          {eventType === 'kill' && (
            <div className="toolbar">
              <input placeholder="silah (ör. ak47, awp)" value={weapon} onChange={(e) => setWeapon(e.target.value)} style={{ width: 140 }} />
              <label><input type="checkbox" checked={firstKill} onChange={(e) => setFirstKill(e.target.checked)} /> açılış</label>
              <label><input type="checkbox" checked={trade} onChange={(e) => setTrade(e.target.checked)} /> trade</label>
              <label><input type="checkbox" checked={headshot} onChange={(e) => setHeadshot(e.target.checked)} /> HS</label>
              {mapName && (
                <select value={area} onChange={(e) => setArea(e.target.value)}>
                  <option value="">bölge: tümü</option>
                  {areas.map((a) => <option key={a}>{a}</option>)}
                </select>
              )}
            </div>
          )}
          {eventType === 'grenade' && (
            <div className="toolbar">
              <select value={grenadeType} onChange={(e) => setGrenadeType(e.target.value)}>
                {['flash', 'smoke', 'he', 'molotov', 'decoy'].map((g) => <option key={g}>{g}</option>)}
              </select>
              <label><input type="checkbox" checked={firstOfType} onChange={(e) => setFirstOfType(e.target.checked)} /> rauntta ilk</label>
            </div>
          )}
          {eventType === 'bomb' && (
            <div className="toolbar">
              <select value={bombAction} onChange={(e) => setBombAction(e.target.value)}>
                <option value="plant">kurulum</option>
                <option value="defuse">çözme</option>
                <option value="explode">patlama</option>
              </select>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                <option value="">site: ikisi</option><option>A</option><option>B</option>
              </select>
            </div>
          )}
          {eventType === 'presence' && (
            <div className="toolbar">
              <select value={area} onChange={(e) => setArea(e.target.value)}>
                <option value="">bölge seç…</option>
                {areas.map((a) => <option key={a}>{a}</option>)}
              </select>
              <label>≥</label>
              <input type="number" min={1} max={5} value={minPlayers} onChange={(e) => setMinPlayers(Number(e.target.value))} style={{ width: 52 }} />
              <span className="meta">oyuncu (harita seçmek zorunlu)</span>
            </div>
          )}
          {eventType === 'economy' && (
            <div className="toolbar">
              <label>ekipman ≥</label>
              <input type="number" step={1000} value={equipMin} onChange={(e) => setEquipMin(Number(e.target.value))} style={{ width: 90 }} />
              <span className="meta">(taraf seçmek zorunlu)</span>
            </div>
          )}
          <div className="toolbar">
            <label>Raunt zamanı</label>
            <input placeholder="başl. sn" value={tFrom} onChange={(e) => setTFrom(e.target.value)} style={{ width: 70 }} />
            <span>–</span>
            <input placeholder="bitiş sn" value={tTo} onChange={(e) => setTTo(e.target.value)} style={{ width: 70 }} />
          </div>
          <div className="toolbar">
            <button onClick={run}>Ara</button>
            {result && (
              <span className="meta">
                {clips.length} sonuç · {result.round_count ?? '—'} raunt kümesi · {result.duration_ms} ms
              </span>
            )}
            {err && <span className="error">{err}</span>}
          </div>
        </div>

        <div className="panel" style={{ maxHeight: 420, overflow: 'auto' }}>
          <h2 style={{ marginTop: 0 }}>Sonuçlar <span className="meta">(satır → replay)</span></h2>
          {clips.length === 0 && <p className="meta">Sorgu çalıştır; klipler burada listelenir.</p>}
          {clips.length > 0 && (
            <table>
              <thead>
                <tr><th>Harita</th><th>Raunt</th><th>Zaman</th><th></th></tr>
              </thead>
              <tbody>
                {clips.slice(0, 100).map((c, i) => (
                  <tr key={i}>
                    <td>{c.map_name}</td>
                    <td>{c.round_number}</td>
                    <td>{Math.floor(c.round_time / 60)}:{String(Math.floor(c.round_time % 60)).padStart(2, '0')}</td>
                    <td><Link to={`/match/${c.match_id}/round/${c.round_number}?t=${c.tick_start}`}>▶ izle</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <StackPanel clips={clips} />
      <HeatmapPanel maps={maps} />
    </>
  );
}

// ── Multi-View Stacking ────────────────────────────────────────────────
function StackPanel({ clips }: { clips: Clip[] }) {
  const [align, setAlign] = useState('bomb_plant');
  const [side, setSide] = useState('T');
  const [tNow, setTNow] = useState(0);
  const [trail, setTrail] = useState(10);
  const [data, setData] = useState<StackResp | null>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  const [err, setErr] = useState('');
  const cvRef = useRef<HTMLCanvasElement>(null);

  async function load() {
    setErr('');
    if (!clips.length) { setErr('Önce yukarıda bir arama çalıştır.'); return; }
    const map0 = clips[0].map_name;
    const seen = new Set<string>();
    const rounds: { match_id: string; round_number: number }[] = [];
    for (const c of clips) {
      if (c.map_name !== map0) continue;
      const k = `${c.match_id}:${c.round_number}`;
      if (!seen.has(k)) { seen.add(k); rounds.push({ match_id: c.match_id, round_number: c.round_number }); }
      if (rounds.length === 10) break;
    }
    try {
      const resp = await api.stack({ rounds, align, side: side || undefined });
      setData(resp);
      setBase(await loadMapBase(resp.map_name));
    } catch (e) { setErr(String(e)); }
  }

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !data || !base) return;
    const ctx = cv.getContext('2d')!;
    drawMapBase(ctx, HW, base, true);
    data.layers.forEach((ly, li) => {
      if (ly.skipped || !ly.players) return;
      const hue = LAYER_HUES[li % 10];
      for (const p of ly.players) {
        ctx.strokeStyle = `hsla(${hue},70%,60%,0.4)`; ctx.lineWidth = 1.5;
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
          ctx.fillStyle = `hsl(${hue},70%,60%)`;
          ctx.beginPath();
          ctx.arc((p.rx[last] * HW) / RADAR, (p.ry[last] * HW) / RADAR, 4, 0, 7);
          ctx.fill();
        }
      }
    });
  }, [data, base, tNow, trail]);

  const okLayers = data?.layers.filter((l) => !l.skipped) ?? [];
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Multi-View Stacking <span className="meta">(arama sonucundaki rauntlar üst üste)</span></h2>
      <div className="toolbar">
        <select value={align} onChange={(e) => setAlign(e.target.value)}>
          <option value="round_start">raunt başı</option>
          <option value="bomb_plant">bomba kurulumu</option>
          <option value="first_kill">ilk temas</option>
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="T">T</option><option value="CT">CT</option><option value="">ikisi</option>
        </select>
        <button onClick={load}>Stack'le</button>
        {data && (
          <span className="meta">
            {data.map_name} · {okLayers.length}/{data.layers.length} katman{' '}
            {data.layers.filter((l) => l.skipped).map((l) => `r${l.round_number}:${l.skipped}`).join(' ')}
          </span>
        )}
        {err && <span className="error">{err}</span>}
      </div>
      {data && (
        <>
          <div className="toolbar">
            <label>t = {tNow.toFixed(1)} sn</label>
            <input type="range" min={-40} max={40} step={0.5} value={tNow} onChange={(e) => setTNow(Number(e.target.value))} style={{ width: 260 }} />
            <label>iz: {trail} sn</label>
            <input type="range" min={2} max={30} value={trail} onChange={(e) => setTrail(Number(e.target.value))} style={{ width: 120 }} />
            <span className="meta">
              {okLayers.map((l, i) => (
                <span key={i} style={{ color: `hsl(${LAYER_HUES[i % 10]},70%,60%)`, marginRight: 6 }}>■ r{l.round_number}</span>
              ))}
            </span>
          </div>
          <canvas ref={cvRef} className="flat" width={HW} height={HW} />
        </>
      )}
    </div>
  );
}

// ── Isı haritası ───────────────────────────────────────────────────────
function HeatmapPanel({ maps }: { maps: string[] }) {
  const [mapName, setMapName] = useState('');
  const [side, setSide] = useState('T');
  const [buy, setBuy] = useState('');
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(40);
  const [data, setData] = useState<HeatmapResp | null>(null);
  const [base, setBase] = useState<MapBase | null>(null);
  const [err, setErr] = useState('');
  const cvRef = useRef<HTMLCanvasElement>(null);

  async function load() {
    setErr('');
    const m = mapName || maps[0];
    if (!m) return;
    const p = new URLSearchParams({ map: m, side });
    if (buy) p.set('buy_type', buy);
    try {
      const resp = await api.heatmap(p);
      setData(resp);
      setBase(await loadMapBase(m));
    } catch (e) { setErr(String(e)); }
  }

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !data || !base) return;
    const ctx = cv.getContext('2d')!;
    drawMapBase(ctx, HW, base, true);
    if (!data.radar) return;
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    const agg = new Map<string, number>();
    let maxv = 0;
    for (const bk of data.buckets) {
      if (bk.t < lo || bk.t > hi) continue;
      for (const [gx, gy, p] of bk.cells) {
        const k = `${gx}:${gy}`;
        const v = (agg.get(k) || 0) + p;
        agg.set(k, v);
        if (v > maxv) maxv = v;
      }
    }
    const cal = data.radar;
    const cellW = ((16 / cal.scale) * HW) / RADAR;
    for (const [k, v] of agg) {
      const [gx, gy] = k.split(':').map(Number);
      const rx = (gx * 16 - cal.pos_x) / cal.scale;
      const ry = (cal.pos_y - (gy + 1) * 16) / cal.scale;
      const i = Math.pow(v / maxv, 0.45);
      ctx.fillStyle = `rgba(${Math.round(255 * i)}, ${Math.round(80 * i)}, 40, ${(0.15 + 0.6 * i).toFixed(3)})`;
      ctx.fillRect((rx * HW) / RADAR, (ry * HW) / RADAR, cellW + 0.5, cellW + 0.5);
    }
  }, [data, base, t0, t1]);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Isı haritası</h2>
      <div className="toolbar">
        <select value={mapName} onChange={(e) => setMapName(e.target.value)}>
          <option value="">{maps[0] ?? 'harita'}</option>
          {maps.slice(1).map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option>T</option><option>CT</option>
        </select>
        <select value={buy} onChange={(e) => setBuy(e.target.value)}>
          <option value="">tüm buy</option>
          {['pistol', 'eco', 'semi', 'force', 'full'].map((b) => <option key={b}>{b}</option>)}
        </select>
        <button onClick={load}>Yükle</button>
        {data && <span className="meta">{data.round_count} raunt · {data.duration_ms} ms</span>}
        {err && <span className="error">{err}</span>}
      </div>
      {data && (
        <>
          <div className="toolbar">
            <label>{Math.min(t0, t1)}–{Math.max(t0, t1)} sn</label>
            <input type="range" min={0} max={115} value={t0} onChange={(e) => setT0(Number(e.target.value))} style={{ width: 180 }} />
            <input type="range" min={0} max={115} value={t1} onChange={(e) => setT1(Number(e.target.value))} style={{ width: 180 }} />
          </div>
          <canvas ref={cvRef} className="flat" width={HW} height={HW} />
        </>
      )}
    </div>
  );
}
