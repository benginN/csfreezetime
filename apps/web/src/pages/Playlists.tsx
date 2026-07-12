import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { isStatic } from '../lib/staticdata';

// Playlist'ler: an koleksiyonları. "Play all" ilk öğeye gider; replay her
// raunt bitişinde playlist modunda otomatik sıradakine geçer (VOD review).
export default function Playlists() {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ['playlists'], queryFn: () => api.playlists() });
  const [name, setName] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  async function create() {
    if (!name.trim()) return;
    await api.playlistCreate(name.trim());
    setName('');
    qc.invalidateQueries({ queryKey: ['playlists'] });
  }

  const importRef = useRef<HTMLInputElement>(null);
  async function doExport() {
    const { exportCollab } = await import('../lib/localcollab');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(exportCollab());
    a.download = 'freezetime-playlists-notes.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function doImport(f: File) {
    const { importCollab } = await import('../lib/localcollab');
    try {
      importCollab(await f.text());
      qc.invalidateQueries({ queryKey: ['playlists'] });
    } catch (err) { window.alert(String(err)); }
  }

  return (
    <>
      <h1>Playlists <span className="meta">— moment collections for VOD review</span></h1>
      {isStatic && (
        <p className="meta" style={{ maxWidth: 640 }}>
          Playlists and notes live <b>in this browser</b> (nothing is stored on
          any server). Use <b>Export</b> to save them as a file — back it up or
          move it to another machine — and <b>Import</b> to load one.
        </p>
      )}
      <div className="toolbar">
        <input
          style={{ width: 220 }}
          placeholder="new playlist name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <button disabled={!name.trim()} onClick={create}>Create</button>
        {isStatic && (
          <>
            <button className="ghost" onClick={doExport}>⬇ Export</button>
            <button className="ghost" onClick={() => importRef.current?.click()}>⬆ Import</button>
            <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
          </>
        )}
      </div>
      <div className="grid cards">
        {(lists.data?.playlists ?? []).map((p) => (
          <div key={p.playlist_id} className="card">
            <div className="teams">
              <span style={{ cursor: 'pointer' }} onClick={() => setOpen(open === p.playlist_id ? null : p.playlist_id)}>
                {p.name}
              </span>
              <span className="meta">{p.items} moments</span>
            </div>
            <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
              <button className="ghost" onClick={() => setOpen(open === p.playlist_id ? null : p.playlist_id)}>
                {open === p.playlist_id ? 'hide' : 'show'}
              </button>
              <button
                className="ghost"
                onClick={async () => { await api.playlistDelete(p.playlist_id); qc.invalidateQueries({ queryKey: ['playlists'] }); }}
              >
                🗑
              </button>
            </div>
            {open === p.playlist_id && <Items id={p.playlist_id} />}
          </div>
        ))}
        {(lists.data?.playlists ?? []).length === 0 && (
          <p className="meta">No playlists yet — add moments from the replay page.</p>
        )}
      </div>
    </>
  );
}

function Items({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
  const items = q.data?.items ?? [];
  return (
    <div style={{ marginTop: 8 }}>
      {items.length > 0 && (
        <Link to={playUrl(items, 0, id)}>
          <button style={{ marginBottom: 6 }}>▶ Play all ({items.length})</button>
        </Link>
      )}
      <table>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.item_id}>
              <td className="meta">{idx + 1}</td>
              <td>{it.team_a ?? '?'} vs {it.team_b ?? '?'}</td>
              <td className="meta">{it.map_name} r{it.round_number}{it.t_sec != null ? ` @${Math.round(it.t_sec)}s` : ''}</td>
              <td className="meta cut">{it.note}</td>
              <td><Link to={playUrl(items, idx, id)}>▶</Link></td>
              <td>
                <button className="ghost" style={{ padding: '0 6px' }}
                  onClick={async () => { await api.playlistDeleteItem(id, it.item_id); qc.invalidateQueries({ queryKey: ['playlist', id] }); qc.invalidateQueries({ queryKey: ['playlists'] }); }}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function playUrl(items: { match_id: string; round_number: number; t_sec: number | null }[], idx: number, plId: number | string): string {
  const it = items[idx];
  const ts = it.t_sec != null ? `&ts=${Math.round(it.t_sec)}` : '';
  return `/match/${it.match_id}?round=${it.round_number}${ts}&playlist=${plId}&idx=${idx}`;
}
