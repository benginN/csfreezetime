// Kişisel veritabanı: kullanıcının kendi maçları TARAYICIDA yaşar
// (IndexedDB). Sunucu işledikten sonra rauntlar buraya indirilir ve
// sunucudaki iz silinir — sitede yer kaplamaz, veri kullanıcıda kalır.
import type { MatchDetail, RoundTicks } from '../api';

const DB = 'tm-local';
const VER = 1;

export interface LocalMatchMeta {
  match_id: string;
  detail: MatchDetail;
  players: { player_id: string; nickname: string; t_rounds: number[]; ct_rounds: number[] }[];
  saved_at: string;
  rounds: number;
  bytes: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, VER);
    rq.onupgradeneeded = () => {
      rq.result.createObjectStore('matches', { keyPath: 'match_id' });
      rq.result.createObjectStore('rounds');
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
  localIds.delete(id);
}
