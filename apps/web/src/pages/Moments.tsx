import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Clip, type QueryResult } from '../api';

// An arama: DSL motorunun (find_moments) kullanıcı dostu yüzü.
// Şablonlar formu doldurur; sonuç klipleri tek tıkla replay'e gider.
// Kayıtlı aramalar localStorage'ta (auth gelince sunucuya taşınır).

interface FormState {
  map: string;
  side: string;
  buys: string[];
  roundMin: string;
  roundMax: string;
  player: string;
  eventType: string;
  weapon: string;
  firstKill: boolean;
  trade: boolean;
  headshot: boolean;
  area: string;
  areaOf: string;
  grenadeType: string;
  bombAction: string;
  site: string;
  minPlayers: string;
  equipMin: string;
  equipMax: string;
  tFrom: string;
  tTo: string;
}

const EMPTY: FormState = {
  map: '', side: '', buys: [], roundMin: '', roundMax: '', player: '',
  eventType: 'kill', weapon: '', firstKill: false, trade: false, headshot: false,
  area: '', areaOf: 'victim', grenadeType: 'smoke', bombAction: 'plant', site: '',
  minPlayers: '3', equipMin: '', equipMax: '', tFrom: '', tTo: '',
};

const PRESETS: { name: string; hint: string; patch: Partial<FormState> }[] = [
  { name: 'Opening picks', hint: 'first kill of each round', patch: { eventType: 'kill', firstKill: true } },
  { name: 'Trade kills', hint: 'kills that answered a death within 5 s', patch: { eventType: 'kill', trade: true } },
  { name: 'AWP kills on eco', hint: 'AWP kills while on eco/semi buy', patch: { eventType: 'kill', weapon: 'AWP', buys: ['eco', 'semi'] } },
  { name: 'Early flashes', hint: 'flashes thrown in the first 20 s', patch: { eventType: 'grenade', grenadeType: 'flash', tFrom: '0', tTo: '20' } },
  { name: 'Early stacks', hint: '3+ players in one area in the first 30 s (set the area)', patch: { eventType: 'presence', minPlayers: '3', tFrom: '0', tTo: '30' } },
  { name: 'B plants', hint: 'bomb plants on the B site', patch: { eventType: 'bomb', bombAction: 'plant', site: 'B' } },
];

function buildQuery(f: FormState): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (f.map) filters.map = f.map;
  if (f.side) filters.side = f.side;
  if (f.buys.length) filters.buy_type = f.buys;
  if (f.roundMin || f.roundMax) {
    filters.round_number = {
      ...(f.roundMin ? { min: Number(f.roundMin) } : {}),
      ...(f.roundMax ? { max: Number(f.roundMax) } : {}),
    };
  }
  if (f.player) filters.player = { nickname: f.player };
  const ev: Record<string, unknown> = { type: f.eventType };
  if (f.eventType === 'kill') {
    if (f.weapon) ev.weapon = f.weapon;
    if (f.firstKill) ev.first_kill = true;
    if (f.trade) ev.trade = true;
    if (f.headshot) ev.headshot = true;
    if (f.area) { ev.area = f.area; ev.area_of = f.areaOf; }
  } else if (f.eventType === 'grenade') {
    ev.grenade_type = f.grenadeType;
    if (f.area) ev.area = f.area;
  } else if (f.eventType === 'bomb') {
    ev.bomb_action = f.bombAction;
    if (f.site) ev.site = f.site;
  } else if (f.eventType === 'presence') {
    ev.area = f.area;
    ev.min_players = Number(f.minPlayers || '3');
  } else if (f.eventType === 'economy') {
    if (f.equipMin) ev.equip_min = Number(f.equipMin);
    if (f.equipMax) ev.equip_max = Number(f.equipMax);
  }
  if (f.tFrom || f.tTo) {
    ev.time_window = { from: Number(f.tFrom || '0'), to: Number(f.tTo || '115') };
  }
  filters.event = ev;
  return { intent: 'find_moments', filters, output: { format: 'clips' } };
}

interface Saved { name: string; form: FormState }
const LS_KEY = 'tm_saved_searches';
const loadSaved = (): Saved[] => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]'); } catch { return []; }
};

export default function Moments() {
  const [form, setForm] = useState<FormState>({ ...EMPTY, firstKill: true });
  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved[]>(loadSaved);
  const [saveName, setSaveName] = useState('');

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // harita + takım adları (klip satırlarında maç etiketi için).
  // arama yalnız son 100 maçı döner; klipler tüm arşivden gelebildiğinden
  // etiketler TAM maç listesinden kurulur (eskiden eski maçlar ham
  // match_id'ye düşüyordu).
  const allMatches = useQuery({ queryKey: ['matches'], queryFn: () => api.matches() });
  const maps = useMemo(
    () => [...new Set((allMatches.data ?? []).map((m) => m.map_name).filter(Boolean))].sort() as string[],
    [allMatches.data],
  );
  const matchLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of allMatches.data ?? []) {
      m.set(x.match_id, x.team_a && x.team_b ? `${x.team_a} vs ${x.team_b}` : (x.name ?? x.match_id.slice(0, 8)));
    }
    return m;
  }, [allMatches.data]);

  // seçilen haritanın bölge adları (area alanına öneri listesi)
  const layout = useQuery({
    queryKey: ['layout', form.map],
    queryFn: () => api.mapLayout(form.map),
    enabled: !!form.map,
  });
  useEffect(() => { setResult(null); }, [form.eventType]);

  async function run() {
    setErr('');
    setBusy(true);
    try {
      if (form.eventType === 'presence' && !form.area) {
        throw new Error('presence needs an area — pick a map, then an area name');
      }
      setResult(await api.query(buildQuery(form)));
    } catch (e) {
      setErr(String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const name = saveName.trim();
    if (!name) return;
    const next = [...saved.filter((s) => s.name !== name), { name, form }];
    setSaved(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    setSaveName('');
  }
  function removeSaved(name: string) {
    const next = saved.filter((s) => s.name !== name);
    setSaved(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  }

  const clips: Clip[] = result?.clips ?? [];

  return (
    <>
      <h1>Moment search <span className="meta">— query the whole archive, jump straight into replay</span></h1>

      <div className="toolbar">
        {PRESETS.map((p) => (
          <button key={p.name} className="ghost" title={p.hint}
            onClick={() => { setForm({ ...EMPTY, ...p.patch }); setResult(null); }}>
            {p.name}
          </button>
        ))}
      </div>
      {saved.length > 0 && (
        <div className="toolbar">
          <span className="meta">saved:</span>
          {saved.map((s) => (
            <span key={s.name} style={{ display: 'inline-flex', gap: 2 }}>
              <button className="ghost" onClick={() => { setForm(s.form); setResult(null); }}>{s.name}</button>
              <button className="ghost" style={{ padding: '0 6px' }} onClick={() => removeSaved(s.name)}>✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="toolbar">
          <label>map</label>
          <select value={form.map} onChange={(e) => set({ map: e.target.value, area: '' })}>
            <option value="">any</option>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          <label>side</label>
          <select value={form.side} onChange={(e) => set({ side: e.target.value })}>
            <option value="">any</option><option>T</option><option>CT</option>
          </select>
          <label>buy</label>
          {['pistol', 'eco', 'semi', 'force', 'full'].map((b) => (
            <label key={b} style={{ color: form.buys.includes(b) ? '#d8ded9' : undefined }}>
              <input
                type="checkbox"
                checked={form.buys.includes(b)}
                onChange={(e) => set({
                  buys: e.target.checked ? [...form.buys, b] : form.buys.filter((x) => x !== b),
                })}
              /> {b}
            </label>
          ))}
          <label>rounds</label>
          <input style={{ width: 46 }} placeholder="min" value={form.roundMin} onChange={(e) => set({ roundMin: e.target.value })} />
          <input style={{ width: 46 }} placeholder="max" value={form.roundMax} onChange={(e) => set({ roundMax: e.target.value })} />
          <label>player</label>
          <input style={{ width: 110 }} placeholder="nickname" value={form.player} onChange={(e) => set({ player: e.target.value })} />
        </div>

        <div className="toolbar">
          <label>event</label>
          <select value={form.eventType} onChange={(e) => set({ eventType: e.target.value })}>
            {['kill', 'grenade', 'bomb', 'presence', 'economy'].map((t) => <option key={t}>{t}</option>)}
          </select>

          {form.eventType === 'kill' && (
            <>
              <input style={{ width: 110 }} list="weapons" placeholder="weapon" value={form.weapon} onChange={(e) => set({ weapon: e.target.value })} />
              <label><input type="checkbox" checked={form.firstKill} onChange={(e) => set({ firstKill: e.target.checked })} /> first kill</label>
              <label><input type="checkbox" checked={form.trade} onChange={(e) => set({ trade: e.target.checked })} /> trade</label>
              <label><input type="checkbox" checked={form.headshot} onChange={(e) => set({ headshot: e.target.checked })} /> HS</label>
              <input style={{ width: 120 }} list="areas" placeholder="area (callout)" value={form.area} onChange={(e) => set({ area: e.target.value })} />
              <select value={form.areaOf} onChange={(e) => set({ areaOf: e.target.value })}>
                <option value="victim">victim in area</option>
                <option value="attacker">attacker in area</option>
              </select>
            </>
          )}
          {form.eventType === 'grenade' && (
            <>
              <select value={form.grenadeType} onChange={(e) => set({ grenadeType: e.target.value })}>
                {['smoke', 'flash', 'molotov', 'he', 'decoy'].map((t) => <option key={t}>{t}</option>)}
              </select>
              <input style={{ width: 120 }} list="areas" placeholder="lands in area" value={form.area} onChange={(e) => set({ area: e.target.value })} />
            </>
          )}
          {form.eventType === 'bomb' && (
            <>
              <select value={form.bombAction} onChange={(e) => set({ bombAction: e.target.value })}>
                {['plant', 'defuse', 'explode'].map((t) => <option key={t}>{t}</option>)}
              </select>
              <select value={form.site} onChange={(e) => set({ site: e.target.value })}>
                <option value="">any site</option><option>A</option><option>B</option>
              </select>
            </>
          )}
          {form.eventType === 'presence' && (
            <>
              <input style={{ width: 130 }} list="areas" placeholder="area (required)" value={form.area} onChange={(e) => set({ area: e.target.value })} />
              <label>min players</label>
              <input style={{ width: 40 }} value={form.minPlayers} onChange={(e) => set({ minPlayers: e.target.value })} />
            </>
          )}
          {form.eventType === 'economy' && (
            <>
              <label>equip value</label>
              <input style={{ width: 66 }} placeholder="min $" value={form.equipMin} onChange={(e) => set({ equipMin: e.target.value })} />
              <input style={{ width: 66 }} placeholder="max $" value={form.equipMax} onChange={(e) => set({ equipMax: e.target.value })} />
            </>
          )}

          <label>time (s)</label>
          <input style={{ width: 46 }} placeholder="from" value={form.tFrom} onChange={(e) => set({ tFrom: e.target.value })} />
          <input style={{ width: 46 }} placeholder="to" value={form.tTo} onChange={(e) => set({ tTo: e.target.value })} />

          <button onClick={run} disabled={busy}>{busy ? '…' : 'Search'}</button>
          <input style={{ width: 120 }} placeholder="save as…" value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="ghost" onClick={save} disabled={!saveName.trim()}>Save</button>
          {err && <span className="error">{err}</span>}
        </div>
        <datalist id="areas">
          {(layout.data?.places ?? []).map((p) => <option key={p.name} value={p.name} />)}
        </datalist>
        <datalist id="weapons">
          {['awp', 'ak47', 'm4a1_silencer', 'm4a1', 'deagle', 'usp_silencer', 'glock',
            'galilar', 'famas', 'mp9', 'mac10', 'ssg08', 'knife'].map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>
      </div>

      {result && (
        <>
          <p className="meta">
            {clips.length} moments · {result.duration_ms} ms
            {clips.length === 200 && ' (first 200 shown)'}
          </p>
          <table>
            <thead>
              <tr><th>Match</th><th>Map</th><th>Round</th><th>Time</th><th /></tr>
            </thead>
            <tbody>
              {clips.map((c, i) => (
                <tr key={i}>
                  <td>{matchLabel.get(c.match_id) ?? c.match_id.slice(0, 8)}</td>
                  <td>{c.map_name}</td>
                  <td>r{c.round_number}</td>
                  <td>{Math.floor(c.round_time / 60)}:{String(Math.floor(c.round_time % 60)).padStart(2, '0')}</td>
                  <td>
                    <Link to={`/match/${c.match_id}?round=${c.round_number}&t=${c.tick_start}`}>
                      ▶ watch
                    </Link>
                  </td>
                </tr>
              ))}
              {!clips.length && <tr><td colSpan={5} className="meta">no moments matched</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
