// Statik sitede notlar & playlist'ler: sunucu yerine TARAYICIDA yaşarlar
// (localStorage; sesli not blob'ları IndexedDB'de). api.ts, statik modda
// ilgili çağrıları buraya yönlendirir — sayfa kodu hiç değişmez.
// "Yerel klasör" hissi: Playlists sayfasındaki Export/Import düğmeleri
// her şeyi tek JSON dosyası olarak indirir / geri yükler.
import type { Note, PlaylistItem } from '../api';
import { deleteNoteAudio, putNoteAudio } from './localdb';
import { getManifest } from './staticdata';

const LS_KEY = 'fz_collab_v1';

interface Store {
  seq: number;
  playlists: { playlist_id: number; name: string; items: PlaylistItem[] }[];
  notes: Record<string, Note[]>; // matchId → notlar
}

function load(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch { /* bozuk kayıt → sıfırdan */ }
  return { seq: 1, playlists: [], notes: {} };
}
function save(st: Store) { localStorage.setItem(LS_KEY, JSON.stringify(st)); }

// maç görünüm bilgisi (harita/takımlar) — yayınlanan manifest'ten
async function matchInfo(matchId: string) {
  try {
    const man = await getManifest();
    const e = man.matches[matchId] as unknown as
      { map_name?: string | null; team_a?: string | null; team_b?: string | null } | undefined;
    return { map_name: e?.map_name ?? null, team_a: e?.team_a ?? null, team_b: e?.team_b ?? null };
  } catch {
    return { map_name: null, team_a: null, team_b: null };
  }
}

export const localPlaylists = {
  async list() {
    const st = load();
    return { playlists: st.playlists.map((p) => ({ playlist_id: p.playlist_id, name: p.name, items: p.items.length })) };
  },
  async create(name: string) {
    const st = load();
    const id = st.seq++;
    st.playlists.push({ playlist_id: id, name, items: [] });
    save(st);
    return { playlist_id: id };
  },
  async get(id: number | string) {
    const p = load().playlists.find((x) => x.playlist_id === Number(id));
    if (!p) throw new Error('playlist not found');
    return { name: p.name, items: p.items };
  },
  async addItem(id: number, item: { match_id: string; round_number: number; t_sec?: number; note?: string }) {
    const st = load();
    const p = st.playlists.find((x) => x.playlist_id === id);
    if (!p) throw new Error('playlist not found');
    const info = await matchInfo(item.match_id);
    const itemId = st.seq++;
    p.items.push({
      item_id: itemId, match_id: item.match_id, round_number: item.round_number,
      t_sec: item.t_sec ?? null, note: item.note ?? null, position: p.items.length,
      ...info,
    });
    save(st);
    return { item_id: itemId };
  },
  async deleteItem(id: number | string, itemId: number) {
    const st = load();
    const p = st.playlists.find((x) => x.playlist_id === Number(id));
    if (p) { p.items = p.items.filter((i) => i.item_id !== itemId); save(st); }
    return { deleted: true };
  },
  async delete(id: number) {
    const st = load();
    st.playlists = st.playlists.filter((x) => x.playlist_id !== id);
    save(st);
    return { deleted: true };
  },
};

export const localNotes = {
  async list(matchId: string) {
    return { notes: load().notes[matchId] ?? [] };
  },
  async create(matchId: string, form: FormData) {
    const st = load();
    const id = st.seq++;
    const audio = form.get('audio');
    if (audio instanceof Blob && audio.size > 0) await putNoteAudio(id, audio);
    const note: Note = {
      note_id: id,
      round_number: Number(form.get('round_number') ?? 0),
      t_sec: Number(form.get('t_sec') ?? 0),
      author: String(form.get('author') ?? ''),
      body: String(form.get('body') ?? ''),
      has_audio: audio instanceof Blob && audio.size > 0,
      created_at: new Date().toISOString(),
    };
    (st.notes[matchId] ??= []).push(note);
    save(st);
    return { note_id: id };
  },
  async delete(id: number) {
    const st = load();
    for (const k of Object.keys(st.notes)) {
      st.notes[k] = st.notes[k].filter((n) => n.note_id !== id);
    }
    save(st);
    await deleteNoteAudio(id).catch(() => {});
    return { deleted: true };
  },
};

// ---- dışa/içe aktarma ("yerel klasör" hissi) -------------------------------
export function exportCollab(): Blob {
  return new Blob([localStorage.getItem(LS_KEY) ?? '{"seq":1,"playlists":[],"notes":{}}'],
    { type: 'application/json' });
}
export function importCollab(json: string): void {
  const incoming = JSON.parse(json) as Store; // biçim bozuksa throw → UI gösterir
  if (!Array.isArray(incoming.playlists) || typeof incoming.notes !== 'object') {
    throw new Error('not a Freezetime playlists/notes export');
  }
  const st = load();
  // birleştir: id çakışmasın diye gelenler yeni id alır
  for (const p of incoming.playlists) {
    const nid = st.seq++;
    st.playlists.push({ playlist_id: nid, name: p.name,
      items: p.items.map((i) => ({ ...i, item_id: st.seq++ })) });
  }
  for (const [mid, ns] of Object.entries(incoming.notes ?? {})) {
    (st.notes[mid] ??= []).push(...ns.map((n) => ({ ...n, note_id: st.seq++, has_audio: false })));
  }
  save(st);
}
