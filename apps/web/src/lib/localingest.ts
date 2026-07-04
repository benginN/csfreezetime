// Ortak lokal işleme akışı: tek demo (Analyze) ve klasör (Create DB)
// sayfaları aynı boru hattını kullanır — sunucu geçici işler, tarayıcı
// saklar, sunucu kopyası silinir.
import { api } from '../api';
import { putMatch, putRound } from './localdb';

export type FileHandle = { getFile(): Promise<File>; name: string };
export type DirHandle = {
  name: string;
  values(): AsyncIterable<{ kind: string; name: string } & FileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle & {
    createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission(o: { mode: string }): Promise<string>;
  requestPermission(o: { mode: string }): Promise<string>;
};

export const BUNDLE_DIR = '.freezetime';

export async function gzipJson(obj: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(obj)])
    .stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
export async function gunzipJson<T>(f: File): Promise<T> {
  const stream = f.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

export async function processDem(
  dir: DirHandle | null,
  fh: FileHandle,
  origin: 'single' | 'folder',
  onPhase: (p: string) => void,
): Promise<string> {
  const file = await fh.getFile();
  onPhase('uploading');
  const form = new FormData();
  form.set('private', '1');
  form.set('demo', file);
  const up = await fetch('/api/v1/upload', { method: 'POST', body: form }).then((r) => r.json());
  if (up.error) throw new Error(up.error);
  const id: string = up.match_id;
  const publicCopy = !!up.public_copy;

  onPhase('processing');
  let done = false;
  for (let i = 0; i < 240; i++) {
    const st = await fetch(`/api/v1/matches/${id}/status`).then((r) => r.json());
    if (st.status === 'private' || st.status === 'ready') { done = true; break; }
    if (st.status === 'failed') throw new Error('demo could not be parsed');
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!done) throw new Error('processing timed out — retry this demo');

  onPhase('downloading');
  const detail = await api.matchDetail(id);
  const players = await api.matchPlayers(id);
  const roundsData: Record<number, unknown> = {};
  let bytes = 0;
  for (const r of detail.rounds) {
    const t = await api.roundTicks(id, r.round_number);
    roundsData[r.round_number] = t;
    bytes += JSON.stringify(t).length;
    await putRound(id, r.round_number, t);
  }
  const baseName = fh.name.replace(/\.dem$/i, '');
  await putMatch({
    match_id: id, detail, players,
    saved_at: new Date().toISOString(),
    rounds: detail.rounds.length, bytes,
    name: baseName, origin,
  });

  if (dir) {
    onPhase('writing bundle');
    const bd = await dir.getDirectoryHandle(BUNDLE_DIR, { create: true });
    const out = await bd.getFileHandle(baseName + '.json.gz', { create: true });
    const w = await out.createWritable();
    await w.write(await gzipJson({ match_id: id, name: baseName, detail, players, rounds: roundsData }));
    await w.close();
  }

  if (!publicCopy) {
    onPhase('removing server copy');
    await fetch(`/api/v1/private/${id}`, { method: 'DELETE' });
  }
  return id;
}

// puan hesabı: raunt kazananlarından (görüntü için)
export function scoreOf(detail: { rounds: RoundRowLite[]; team_a_id: string | null }): [number, number] {
  let a = 0, b = 0;
  for (const r of detail.rounds) {
    if (!r.winner_side) continue;
    const winnerTeam = r.winner_side === 'T' ? r.t_team_id : r.ct_team_id;
    if (winnerTeam && winnerTeam === detail.team_a_id) a++; else b++;
  }
  return [a, b];
}
interface RoundRowLite {
  winner_side: 'T' | 'CT' | null;
  t_team_id: string | null;
  ct_team_id: string | null;
}
