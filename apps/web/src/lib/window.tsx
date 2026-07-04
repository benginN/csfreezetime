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

export function WindowPicker({ win, onChange }: { win: string; onChange: (w: string) => void }) {
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
    </span>
  );
}
