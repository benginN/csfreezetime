// Statik yayın modu (Faz Y1, docs/mimari.md §11.1): site GitHub Pages'ta,
// sayfa verisi /data/api/*.json dosyalarında, maç paketleri GitHub
// Releases'ta yaşar. Bu modül api.ts'in üçüncü veri yoludur — sunucu yok.
//
// build: VITE_STATIC=1 vite build  (publish.sh ayarlar)
import { importBundle, localIds, type Bundle } from './localdb';
import type { SearchResult } from '../api';

export const isStatic = import.meta.env.VITE_STATIC === '1';

// Statik sitede sunulmayan özellikler bu hatayı fırlatır; sayfalar
// mesajı olduğu gibi gösterebilir.
export const STATIC_UNAVAILABLE =
  'not available on the static site — run the self-hosted studio for this feature';

// ---- URL → dosya eşlemesi -------------------------------------------------
// services/stats-svc/cmd/export/canon.go::canonPath ile BİREBİR aynı kural.
// İki taraf ayrışırsa statik site 404 verir; kural değişirse ikisi birlikte
// değişmeli (sözleşme testi: canon_test.go).
const unsafeChar = /[^A-Za-z0-9._-]/g;
const slugPart = (s: string) => s.replace(unsafeChar, '_');

export function staticApiPath(rawUrl: string): string {
  const u = new URL(rawUrl, window.location.origin);
  if (!u.pathname.startsWith('/api/v1/')) throw new Error('not an /api/v1/ url: ' + rawUrl);
  const segs = u.pathname.slice('/api/v1/'.length).replace(/^\/+|\/+$/g, '').split('/').map(slugPart);
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  let name = segs[segs.length - 1];
  for (const k of keys) {
    for (const v of u.searchParams.getAll(k).slice().sort()) {
      if (v === '') continue;
      name += '~' + slugPart(k + '=' + v);
    }
  }
  return [...segs.slice(0, -1), name + '.json'].join('/');
}

// taban yol: alt-yol yayınında (/csfreezetime/) veriler oradan okunur
const BASE = import.meta.env.BASE_URL;

export async function staticGet<T>(url: string): Promise<T> {
  const r = await fetch(BASE + 'data/api/' + staticApiPath(url));
  if (!r.ok) throw new Error(STATIC_UNAVAILABLE);
  return r.json() as Promise<T>;
}

// ---- maç paketleri ---------------------------------------------------------
interface ManifestEntry { tag: string; file: string; rounds: number; bytes: number }
interface Manifest { bundle_base: string; matches: Record<string, ManifestEntry> }

let manifestP: Promise<Manifest> | null = null;
export function getManifest(): Promise<Manifest> {
  manifestP ??= fetch(BASE + 'data/manifest.json').then((r) => {
    if (!r.ok) throw new Error('manifest missing');
    return r.json();
  });
  return manifestP;
}

async function gunzipJson<T>(blob: Blob): Promise<T> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

// Paketi indirip IndexedDB'ye açar (origin 'static' — My DB listesinde
// görünmez ama replay/heatmap/stack yolları localIds üzerinden çalışır).
// İkinci ziyaret IndexedDB'den gelir, tekrar indirilmez.
const inflight = new Map<string, Promise<void>>();
export function ensureBundle(matchId: string): Promise<void> {
  if (localIds.has(matchId)) return Promise.resolve();
  let p = inflight.get(matchId);
  if (!p) {
    p = (async () => {
      const man = await getManifest();
      const e = man.matches[matchId];
      if (!e) throw new Error(STATIC_UNAVAILABLE);
      const r = await fetch(`${man.bundle_base}/${e.tag}/${e.file}`);
      if (!r.ok) throw new Error(`bundle download failed (HTTP ${r.status})`);
      const blob = await r.blob();
      const bundle = await gunzipJson<Bundle>(blob);
      await importBundle({ ...bundle, origin: 'static' }, blob.size);
    })().finally(() => inflight.delete(matchId));
    inflight.set(matchId, p);
  }
  return p;
}

// ---- istemci tarafı arama ---------------------------------------------------
// Sunucudaki search'ün sadeleştirilmiş karşılığı: kelime-başı eşleşme,
// 1-2 karakterlik tokenlarda da kelime başı, sayı tokenlarında tam kelime.
interface SearchIndex {
  teams: { id: string; name: string }[];
  players: { id: string; name: string }[];
  tournaments: { name: string; matches: number }[];
  matches: SearchResult['matches'];
}
let indexP: Promise<SearchIndex> | null = null;

function tokenMatch(hay: string, token: string): boolean {
  const words = hay.toLowerCase().split(/[^a-z0-9]+/);
  if (/^\d+$/.test(token)) return words.includes(token);
  return words.some((w) => w.startsWith(token));
}
function matchesAll(hay: string, tokens: string[]): boolean {
  return tokens.every((t) => tokenMatch(hay, t));
}

export async function staticSearch(q: string): Promise<SearchResult> {
  indexP ??= fetch(BASE + 'data/search-index.json').then((r) => r.json());
  const idx = await indexP;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  // boş sorgu = tüm maç listesi + turnuva şeridi (sunucu davranışıyla
  // uyumlu; MatchPage parça-kardeş tespiti ve Home TournamentStrip kullanır)
  if (!tokens.length) {
    return {
      total: idx.matches.length, teams: [], players: [],
      tournaments: idx.tournaments ?? [], matches: idx.matches,
    };
  }
  const teams = (idx.teams ?? []).filter((t) => matchesAll(t.name, tokens)).slice(0, 8);
  const players = (idx.players ?? []).filter((p) => matchesAll(p.name, tokens)).slice(0, 8);
  const tournaments = (idx.tournaments ?? []).filter((t) => matchesAll(t.name, tokens)).slice(0, 6);
  const matches = (idx.matches ?? []).filter((m) =>
    matchesAll([m.name, m.team_a, m.team_b, m.tournament, m.map_name].filter(Boolean).join(' '), tokens),
  ).slice(0, 20);
  return {
    total: teams.length + players.length + tournaments.length + matches.length,
    teams, players, tournaments, matches,
  };
}
