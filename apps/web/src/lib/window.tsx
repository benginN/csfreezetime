import { useSearchParams } from 'react-router-dom';

// Zaman penceresi: ?win=8w | 3m | 1y (sayı + birim, serbest). Boş = tüm arşiv.
// Takım iki yıl önceki halinden farklı olabilir; koç pencereyi kendi seçer.
export function winToSince(win: string): string {
  const m = /^(\d+)([wmy])$/.exec(win);
  if (!m) return '';
  const n = Number(m[1]);
  const d = new Date();
  if (m[2] === 'w') d.setDate(d.getDate() - 7 * n);
  if (m[2] === 'm') d.setMonth(d.getMonth() - n);
  if (m[2] === 'y') d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

export function useWindow(): [string, string, (w: string) => void] {
  const [params, setParams] = useSearchParams();
  const win = params.get('win') ?? '';
  const set = (w: string) => {
    const p = new URLSearchParams(params);
    if (w) p.set('win', w);
    else p.delete('win');
    setParams(p, { replace: true });
  };
  return [win, winToSince(win), set];
}

// Kadro çekirdeği filtresi: ?roster=N — takımın SON maçındaki beşliden en az
// N kişinin oynadığı maçlar. (Koç bilgisi demolarda yok; bu onun pratik vekili.)
export function useRoster(): [number, (n: number) => void] {
  const [params, setParams] = useSearchParams();
  const roster = Number(params.get('roster') ?? '0');
  const set = (n: number) => {
    const p = new URLSearchParams(params);
    if (n > 0) p.set('roster', String(n));
    else p.delete('roster');
    setParams(p, { replace: true });
  };
  return [roster, set];
}

// Kadro filtresi tooltip'i: koça "neden var" cümlesiyle birlikte
const LINEUP_TIP =
  'Roster changes matter — a team with new players plays differently. '
  + 'Keep only matches with at least N of the team\'s current five (the five '
  + 'from their most recent match) on the server. 5/5 = the exact current '
  + 'lineup; lower it to tolerate a stand-in; off = every match.';

export function WindowPicker({ win, onChange, roster, onRoster }: {
  win: string; onChange: (w: string) => void;
  roster?: number; onRoster?: (n: number) => void;
}) {
  const m = /^(\d+)([wmy])$/.exec(win);
  const n = m ? m[1] : '';
  const u = m ? m[2] : 'm';
  return (
    <span className="toolbar" style={{ display: 'inline-flex', gap: 4 }}>
      <label className="meta">last</label>
      <input
        type="number" min={1} style={{ width: 54 }} value={n}
        placeholder="all"
        onChange={(e) => onChange(e.target.value ? `${e.target.value}${u}` : '')}
      />
      <select value={u} onChange={(e) => n && onChange(`${n}${e.target.value}`)}>
        <option value="w">weeks</option>
        <option value="m">months</option>
        <option value="y">years</option>
      </select>
      {win && <button className="ghost" onClick={() => onChange('')}>all time</button>}
      {onRoster && (
        <>
          <label className="meta" title={LINEUP_TIP}>· lineup ≥</label>
          <select value={roster ?? 0} onChange={(e) => onRoster(Number(e.target.value))} title={LINEUP_TIP}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n === 0 ? 'off' : `${n}/5`}</option>
            ))}
          </select>
        </>
      )}
    </span>
  );
}
