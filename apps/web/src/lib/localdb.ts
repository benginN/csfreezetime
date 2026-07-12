// Kişisel veritabanı: kullanıcının kendi maçları TARAYICIDA yaşar
// (IndexedDB). Sunucu işledikten sonra rauntlar buraya indirilir ve
// sunucudaki iz silinir — sitede yer kaplamaz, veri kullanıcıda kalır.
import type { MatchDetail, RoundTicks } from '../api';

const DB = 'tm-local';
const VER = 2;

export interface LocalMatchMeta {
  match_id: string;
  detail: MatchDetail;
  players: { player_id: string; nickname: string; t_rounds: number[]; ct_rounds: number[]; is_coach?: boolean }[];
  saved_at: string;
  rounds: number;
  bytes: number;
  name?: string;                 // kaynak dosya adı (parça tespiti: …-p1/-p2)
  // hangi kaynaktan geldi: single=Analyze, folder=kendi demoların,
  // archive=kamu arşivinden seçilip indirilen maç (My DB kompozisyonu),
  // static=statik sitede Releases'tan indirilen kamu paketi (önbellek —
  // My DB listelerinde gösterilmez)
  origin?: 'single' | 'folder' | 'archive' | 'static';
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('matches')) db.createObjectStore('matches', { keyPath: 'match_id' });
      if (!db.objectStoreNames.contains('rounds')) db.createObjectStore('rounds');
      if (!db.objectStoreNames.contains('misc')) db.createObjectStore('misc'); // klasör tutamacı vb.
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const rq = fn(db.transaction(store, mode).objectStore(store));
    rq.onsuccess = () => res(rq.result as T);
    rq.onerror = () => rej(rq.error);
  }));
}

// modül düzeyinde kimlik kaydı: api şimi senkron kontrol edebilsin
export const localIds = new Set<string>();
export async function loadRegistry(): Promise<void> {
  try {
    const keys = await tx<IDBValidKey[]>('matches', 'readonly', (s) => s.getAllKeys());
    keys.forEach((k) => localIds.add(String(k)));
  } catch { /* IndexedDB yoksa sessizce geç */ }
}

export const putMatch = (m: LocalMatchMeta) =>
  tx('matches', 'readwrite', (s) => s.put(m)).then(() => { localIds.add(m.match_id); });
export const getMatch = (id: string) =>
  tx<LocalMatchMeta | undefined>('matches', 'readonly', (s) => s.get(id));
export const listMatches = () =>
  tx<LocalMatchMeta[]>('matches', 'readonly', (s) => s.getAll());
export const putRound = (id: string, n: number, data: RoundTicks) =>
  tx('rounds', 'readwrite', (s) => s.put(data, `${id}:${n}`));
export const getRound = (id: string, n: number) =>
  tx<RoundTicks | undefined>('rounds', 'readonly', (s) => s.get(`${id}:${n}`));

export async function deleteLocal(id: string): Promise<void> {
  const meta = await getMatch(id);
  await tx('matches', 'readwrite', (s) => s.delete(id));
  const n = meta?.rounds ?? 40;
  for (let i = 1; i <= n; i++) {
    await tx('rounds', 'readwrite', (s) => s.delete(`${id}:${i}`));
  }
  await deleteVoice(id).catch(() => {});
  localIds.delete(id);
}

// takım telsizi (voice comms) kaydı: maç başına bir ses dosyası — yalnız
// yerelde yaşar (gizlilik), replay'de zamana kilitli çalınır (ReplayView)
export const putVoice = (id: string, f: Blob) =>
  tx('misc', 'readwrite', (s) => s.put(f, `voice:${id}`));
export const getVoice = (id: string) =>
  tx<Blob | undefined>('misc', 'readonly', (s) => s.get(`voice:${id}`));
export const deleteVoice = (id: string) =>
  tx('misc', 'readwrite', (s) => s.delete(`voice:${id}`));
export const listVoiceIds = () =>
  tx<IDBValidKey[]>('misc', 'readonly', (s) => s.getAllKeys())
    .then((ks) => new Set(ks.map(String)
      .filter((k) => k.startsWith('voice:')).map((k) => k.slice(6))));

// klasör tutamacı (File System Access API) — IndexedDB tutamaç saklayabilir
export const saveDirHandle = (h: unknown) =>
  tx('misc', 'readwrite', (s) => s.put(h, 'dirHandle'));
export const getDirHandle = () =>
  tx<unknown>('misc', 'readonly', (s) => s.get('dirHandle'));

export interface Bundle {
  match_id: string;
  name?: string;
  detail: MatchDetail;
  players: LocalMatchMeta['players'];
  rounds: Record<number, RoundTicks>;
  origin?: 'single' | 'folder' | 'archive' | 'static'; // arşiv kopyaları rozetini pakette de korur
}

// paketleri IndexedDB'ye aç (klasörden hızlı içe aktarma)
export async function importBundle(b: Bundle, bytes: number): Promise<void> {
  for (const [n, t] of Object.entries(b.rounds)) {
    await putRound(b.match_id, Number(n), t);
  }
  await putMatch({
    match_id: b.match_id, detail: b.detail, players: b.players,
    saved_at: new Date().toISOString(),
    rounds: b.detail.rounds.length, bytes,
    name: b.name, origin: b.origin ?? 'folder',
  });
}
