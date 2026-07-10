import { localIds, getMatch as getLocalMatch, getRound as getLocalRound } from './lib/localdb';
import { isStatic, staticGet, ensureBundle, staticSearch, STATIC_UNAVAILABLE } from './lib/staticdata';
// stats-svc API istemcisi — tüm tipler sunucu yanıtlarıyla birebir.
// Üç veri yolu: (1) sunucu (self-host/stüdyo), (2) My DB (IndexedDB,
// localIds), (3) statik yayın (GitHub Pages JSON + Releases paketleri).

export interface Team {
  team_id: string;
  name: string;
  matches: number;
}

export interface MatchSummary {
  match_id: string;
  map_name: string | null;
  status: string;
  name: string | null;
  team_a_id: string | null;
  team_a: string | null;
  team_b_id: string | null;
  team_b: string | null;
  rounds: number;
  score_a: number;
  score_b: number;  played_at: string | null;
  tournament: string | null;
}

export interface RoundRow {
  round_number: number;
  start_tick: number | null;
  freeze_end_tick: number | null;
  end_tick: number | null;
  winner_side: 'T' | 'CT' | null;
  end_reason: string | null;
  bomb_site: string | null;
  bomb_plant_tick: number | null;
  t_buy_type: string | null;
  ct_buy_type: string | null;
  t_cluster: number | null;
  ct_cluster: number | null;
  t_team_id: string | null;
  ct_team_id: string | null;
  max_t_prob?: number | null;   // winprob zirveleri (thrown tespiti)
  max_ct_prob?: number | null;
  t_pred_prob?: number | null;  // modelin raunt öncesi bu stratejiye verdiği p
  ct_pred_prob?: number | null;
  t_awps?: number;   // 5-20 sn penceresinde AWP taşıyan oyuncu sayısı
  ct_awps?: number;
}

export interface Tendency {
  map_name: string;
  side: 'T' | 'CT';
  cluster_id: number;
  label: string | null;
  top_places: { place: string; weight: number }[];
  observed: number;
  sample_size: number;
  prob: number;
}

export interface MatchPlayerRow {
  player_id: string; nickname: string;
  t_rounds: number[]; ct_rounds: number[]; is_coach?: boolean;
  // raunt-bazlı paralel diziler (HUD kümülatif ADR/EF/UD; lokal maçlarda yok)
  stat_rounds?: number[]; stat_dmg?: number[]; stat_util?: number[]; stat_flashed?: number[];
}

export interface KillRow {
  round_number: number;
  tick: number;
  round_time: number;
  attacker: string | null;
  victim: string | null;
  assister: string | null;
  weapon: string | null;
  headshot: boolean | null;
}

export interface SearchResult {
  total: number;
  teams: { id: string; name: string }[];
  players: { id: string; name: string }[];
  tournaments: { name: string; matches: number }[];
  matches: {
    match_id: string;
    map_name: string | null;
    name: string | null;
    team_a: string | null;
    team_b: string | null;
    score_a: number;
    score_b: number;
    played_at: string | null;
    tournament: string | null;
  }[];
}

export interface MatchDetail {
  match_id: string;
  map_name: string | null;
  status: string;
  team_a_id: string | null;
  team_a: string | null;
  team_b_id: string | null;
  team_b: string | null;
  tournament: string | null;
  rounds: RoundRow[];
  kills: KillRow[];
}

export interface RadarCal {
  pos_x: number;
  pos_y: number;
  scale: number;
  has_lower: boolean;
  split_z: number | null;
}

export interface PlayerTrack {
  player_id: string;
  nickname: string;
  side: 'T' | 'CT';
  rx: (number | null)[];
  ry: (number | null)[];
  yaw: (number | null)[];
  hp: (number | null)[];
  armor: (number | null)[];
  alive: (boolean | null)[];
  weapon: (string | null)[];
  inv: (string[] | null)[];
  flash: (number | null)[];
  helmet: (boolean | null)[];
  lower?: (boolean | null)[];
  shots: number[];
  money: (number | null)[];
  wz: (number | null)[];
  pitch: (number | null)[];
  money_start: number | null;
  equip_value: number | null;
}

export interface KillMark {
  tick: number;
  attacker: string | null;
  victim: string | null;
  weapon: string | null;
  victim_rx: number | null;
  victim_ry: number | null;
  lower?: boolean | null;
}

export interface GrenadeMark {
  type: 'smoke' | 'molotov' | 'incendiary' | 'flash' | 'he' | 'decoy';
  tick: number;
  side: string | null;
  thrower: string | null;
  rx: number | null;
  ry: number | null;
  lower?: boolean | null;
  throw_tick: number | null;
  throw_rx: number | null;
  throw_ry: number | null;
  throw_lower?: boolean | null;
}

export interface RoundTicks {
  match_id: string;
  map_name: string;
  round_number: number;
  freeze_end_tick: number | null;
  tick_rate: number;
  radar: RadarCal;
  ticks: number[];
  players: PlayerTrack[];
  kills: KillMark[];
  grenades: GrenadeMark[];
}

export interface MapLayout {
  map: string;
  cell_px: number;
  radar: RadarCal;
  cells: [number, number, number][];
  cells_lower?: [number, number, number][];
  places: { name: string; rx: number; ry: number; count: number }[];
}

export interface Clip {
  match_id: string;
  map_name: string;
  round_number: number;
  tick: number;
  round_time: number;
  tick_start: number;
  tick_end: number;
}

export interface QueryResult {
  intent: string;
  clips?: Clip[];
  rounds?: { match_id: string; map_name: string; round_number: number }[];
  count?: number;
  round_count?: number;
  per_round?: number;
  duration_ms: number;
}

export interface HeatmapResp {
  map: string;
  side: string;
  round_count: number;
  radar: RadarCal | null;
  buckets: { t: number; cells: [number, number, number][] }[];
  duration_ms: number;
}

export interface MatchHeatmap {
  cells: [number, number, number][]; // [cx, cy, weight] radar hücreleri
  cells_lower?: [number, number, number][];
  cell_radar: number;
  round_count: number;
  radar: RadarCal;
}

export interface TeamSummary {
  team_id: string;
  team: string;
  overview: {
    matches: number; wins: number;
    t_rounds: number; t_wins: number;
    ct_rounds: number; ct_wins: number;
    pistol_rounds: number; pistol_wins: number;
  };
  maps: {
    map_name: string; matches: number; wins: number;
    round_wins: number; rounds: number;
  }[];
  players: {
    player_id: string; nickname: string; rounds: number; matches: number;
    adr: number; kills: number; deaths: number; flash_assists: number;
    survival_pct: number; current: boolean; last_played: string | null;
  }[];
  map_strats: {
    map_name: string; side: 'T' | 'CT'; label: string | null;
    top_places: { place: string; weight: number }[];
    prob: number; league_prob: number;
  }[];
}

export interface ReportSetup {
  side: 'T' | 'CT';
  t_offset: number;
  pattern_id: number;
  pattern: { place: string; n: number }[];
  observed: number;
  sample_size: number;
  share: number;
  avg_hold_sec: number | null;
  representatives: { match_id: string; round_number: number }[];
}

export interface ReportUtility {
  side: 'T' | 'CT';
  type: string;
  cluster_id: number;
  label: string | null;
  det_rx: number;
  det_ry: number;
  throw_rx: number | null;
  throw_ry: number | null;
  count: number;
  share: number;
  t_avg: number | null;
  t_std: number | null;
  strat_mix: Record<string, number> | null;
  representatives: { match_id: string; round_number: number }[];
}

export interface ReportPlayer {
  nickname: string;
  player_id: string;
  side: 'T' | 'CT';
  rounds: number;
  entry_attempt_share: number | null;
  entry_success: number | null;
  opening_kills: number;
  opening_deaths: number;
  lurk_dist_avg: number | null;
  anchor_place: string | null;
  anchor_share: number | null;
  awp_round_share: number | null;
  util_per_round: number | null;
  flash_assists_pr: number | null;
  adr: number | null;
  tags: string[];
}

export interface RoundTendencyRow {
  rclass: string; side: 'T' | 'CT'; cluster_id: number;
  label: string | null; top_places: { place: string; weight: number }[];
  n: number; total: number; share: number;
}

export interface ReportResp {
  util_dmg: { side: string; he_dmg: number; fire_dmg: number; he_n: number; fire_n: number }[];
  exec_templates: { pattern: string[]; n: number; wins: number; site_mix: Record<string, number>; recency_score: number }[];
  window_since?: string;
  archive_wide?: string[];
  team_id: string;
  team: string;
  map: string;
  insufficient?: boolean;
  overview: {
    matches: number; wins: number;
    t_rounds: number; t_wins: number;
    ct_rounds: number; ct_wins: number;
    pistol_rounds: number; pistol_wins: number;
    conv_after_pistol_win_n: number; conv_after_pistol_win: number;
  };
  economy: {
    buy_T: Record<string, number>;
    buy_CT: Record<string, number>;
    after_pistol_loss: Record<string, number>;
  };
  tendencies: (Tendency & { side: 'T' | 'CT' })[];
  round_tendencies: RoundTendencyRow[];
  boosts: { side: 'T' | 'CT'; place: string; n: number;
    representatives: { match_id: string; round_number: number }[] }[];
  playbook?: { rush_n: number; rush_total: number; setstrat_rounds: number; t_rounds_all: number };
  conditional: {
    side: 'T' | 'CT'; buy_type: string; cluster_id: number;
    label: string | null; top_places: { place: string; weight: number }[];
    prob: number; sample_size: number;
  }[];
  setups: ReportSetup[];
  rotations: {
    side: 'T' | 'CT'; pattern_id: number; place: string;
    n_contacts: number; rotate_rate: number; med_delay_sec: number | null;
    dest_mix: Record<string, number> | null;
  }[];
  utility: ReportUtility[];
  players: ReportPlayer[];
  thrown: { match_id: string; round_number: number; side: 'T' | 'CT'; peak: number }[];
  flash_sync: {
    side: 'T' | 'CT'; kills: number; blind_kills: number;
    med_gap: number | null; good_flashes: number | null; converted: number | null;
  }[];
  trade_pairs: { trader: string; avenged: string; n: number }[];
}

export interface WinprobCell {
  alive_t: number; alive_ct: number; bomb: boolean; tbucket: number; p: number; n: number;
}

export interface PlayerProfile {
  util_dmg: { side: string; he_dmg: number; fire_dmg: number; he_n: number; fire_n: number }[];
  player_id: string;
  nickname: string;
  team: string | null;
  roles: {
    side: 'T' | 'CT'; map_name: string; rounds: number;
    entry_attempt_share: number | null; entry_success: number | null;
    opening_kills: number; opening_deaths: number;
    lurk_dist_avg: number | null;
    anchor_place: string | null; anchor_share: number | null;
    awp_round_share: number | null; util_per_round: number | null;
    flash_assists_pr: number | null; adr: number | null; tags: string[];
  }[];
  maps: {
    map_name: string; rounds: number; matches: number; adr: number;
    kills: number; deaths: number; assists: number; survival_pct: number;
  }[];
  openings: { map_name: string; won: number; lost: number }[];
  flash: {
    side: 'T' | 'CT'; thrown: number; enemies: number;
    teammates: number; avg_blind: number | null;
  }[];
  trades: { side: 'T' | 'CT'; made: number }[];
  deaths_traded: { side: 'T' | 'CT'; deaths: number; traded: number }[];
  clutches: { versus: number; attempts: number; wins: number }[];
  big_rounds: {
    match_id: string; round_number: number; kills: number;
    side: 'T' | 'CT'; map_name: string; played_at: string;
  }[];
  clutch_moments: {
    match_id: string; round_number: number; versus: number;
    won: boolean; start_sec: number; map_name: string | null;
  }[];
  flags: {
    metric: string; value: number; baseline_mean: number; baseline_std: number;
    z: number; event_name: string | null; map_name: string | null; match_id: string;
  }[];
}

export interface StackLayer {
  match_id: string;
  round_number: number;
  align_tick: number;
  skipped?: string;
  players?: {
    side: string; nick: string; t: number[]; rx: number[]; ry: number[];
    lower?: boolean[]; hp: number[]; armor: number[]; money: number[];
    inv_t: number[]; inv_v: string[];
  }[];
}

export interface StackResp {
  map_name: string;
  radar: RadarCal;
  align: string;
  layers: StackLayer[];
}

async function get<T>(url: string): Promise<T> {
  if (isStatic) return staticGet<T>(url);
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j as T;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  if (isStatic) throw new Error(STATIC_UNAVAILABLE);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j as T;
}

export interface ClusterInfo {
  cluster_id: number;
  label: string | null;
  size: number;
  top_places: { place: string; weight: number }[];
  representatives: { match_id: string; round_number: number }[];
}

export interface MlStatus {
  evaluation: {
    map_name: string; side: string; best_method: string;
    logloss_league: number | null; logloss_team: number | null;
    logloss_team_buy: number | null; logloss_team_vs: number | null;
    logloss_team_style: number | null; logloss_lgbm: number | null;
    lgbm_importance?: Record<string, number>;
    test_rounds: number | null;
  }[];
  inventory: {
    matches: number; rounds: number; clusters: number; tendency_rows: number;
    cond_rows: number; vs_rows: number; anomaly_flags: number;
    winprob_cells: number; exec_templates: number; clutches: number;
  };
}

export interface Prediction {
  method: 'league' | 'team' | 'team_buy' | 'team_vs' | 'team_style' | 'lgbm';
  clusters: {
    cluster_id: number;
    label: string | null;
    top_places: { place: string; weight: number }[];
    prob: number;
  }[];
  evidence: { sample_size: number; note: string };
}

export interface PatternNade {
  type: string; side: 'T' | 'CT'; thrower: string; player_id: string;
  trx: number; try: number; drx: number; dry: number;
  t: number; match_id: string; round_number: number;
}

export interface PlaylistItem {
  item_id: number;
  match_id: string;
  round_number: number;
  t_sec: number | null;
  note: string | null;
  position: number;
  map_name: string | null;
  team_a: string | null;
  team_b: string | null;
}

export interface Note {
  note_id: number;
  round_number: number;
  t_sec: number;
  author: string;
  body: string;
  has_audio: boolean;
  created_at: string;
}

export const api = {
  playlists: () =>
    get<{ playlists: { playlist_id: number; name: string; items: number }[] }>('/api/v1/playlists'),
  playlistCreate: (name: string) => post<{ playlist_id: number }>('/api/v1/playlists', { name }),
  playlist: (id: number | string) =>
    get<{ name: string; items: PlaylistItem[] }>(`/api/v1/playlists/${id}`),
  playlistAdd: (id: number, item: { match_id: string; round_number: number; t_sec?: number; note?: string }) =>
    post<{ item_id: number }>(`/api/v1/playlists/${id}/items`, item),
  playlistDeleteItem: (id: number | string, item: number) =>
    fetch(`/api/v1/playlists/${id}/items/${item}`, { method: 'DELETE' }).then((r) => r.json()),
  playlistDelete: (id: number) =>
    fetch(`/api/v1/playlists/${id}`, { method: 'DELETE' }).then((r) => r.json()),
  notes: (matchId: string) => get<{ notes: Note[] }>(`/api/v1/matches/${matchId}/notes`),
  noteCreate: (matchId: string, form: FormData) =>
    fetch(`/api/v1/matches/${matchId}/notes`, { method: 'POST', body: form }).then((r) => r.json()),
  noteDelete: (id: number) =>
    fetch(`/api/v1/notes/${id}`, { method: 'DELETE' }).then((r) => r.json()),
  search: (q: string) =>
    isStatic ? staticSearch(q) : get<SearchResult>('/api/v1/search?q=' + encodeURIComponent(q)),
  teams: () => get<Team[]>('/api/v1/teams'),
  tendencies: (teamId: string) => get<Tendency[]>(`/api/v1/teams/${teamId}/tendencies`),
  clusters: (map: string, side: string) => get<ClusterInfo[]>(`/api/v1/clusters?map=${map}&side=${side}`),
  mlStatus: () => get<MlStatus>('/api/v1/mlstatus'),
  renameCluster: (map: string, side: string, id: number, label: string) =>
    fetch(`/api/v1/clusters/${map}/${side}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }).then((r) => r.json()),
  predict: (p: URLSearchParams) => get<Prediction>('/api/v1/predict?' + p),
  teamControl: (id: string, map: string, since = '', roster = 0) =>
    get<{ rows: { place: string; n: number; a_share: number; b_share: number;
      none_share: number; lift_a: number; lift_b: number }[];
      rounds: number; base_a: number; base_b: number }>(
      `/api/v1/teams/${id}/control?map=${encodeURIComponent(map)}&since=${since}&roster_min=${roster}`),
  scenario: (p: URLSearchParams) =>
    get<{ n: number; reps: { match_id: string; round_number: number }[];
      rows: { cluster_id: number; label: string | null;
        top_places: { place: string; weight: number }[];
        n: number; share: number; base_share: number; lift: number }[] }>(
      '/api/v1/scenario?' + p),
  patterns: (p: URLSearchParams) =>
    get<{ nades: PatternNade[]; truncated: boolean }>('/api/v1/patterns?' + p),
  matches: (teamId?: string, since = '', roster = 0) =>
    get<MatchSummary[]>('/api/v1/matches' + (teamId ? `?team_id=${teamId}&since=${since}&roster_min=${roster}` : '')),
  matchDetail: async (id: string): Promise<MatchDetail> => {
    if (isStatic) await ensureBundle(id);
    if (localIds.has(id)) {
      const m = await getLocalMatch(id);
      if (m) return m.detail;
    }
    return get<MatchDetail>(`/api/v1/matches/${id}`);
  },
  matchPlayers: async (id: string): Promise<MatchPlayerRow[]> => {
    if (isStatic) await ensureBundle(id);
    if (localIds.has(id)) {
      const m = await getLocalMatch(id);
      if (m) return m.players;
    }
    return get<MatchPlayerRow[]>(`/api/v1/matches/${id}/players`);
  },
  matchHeatmap: async (id: string, p: URLSearchParams): Promise<MatchHeatmap> => {
    if (isStatic) await ensureBundle(id);
    if (localIds.has(id)) {
      const { localHeatmap } = await import('./lib/localcompute');
      return localHeatmap(id, p);
    }
    return get<MatchHeatmap>(`/api/v1/matches/${id}/heatmap?` + p);
  },
  teamHeatmap: (id: string, p: URLSearchParams) =>
    get<MatchHeatmap>(`/api/v1/teams/${id}/heatmap?` + p),
  teamSummary: (id: string, since = '', roster = 0) =>
    get<TeamSummary>(`/api/v1/teams/${id}/summary?since=${since}&roster_min=${roster}`),
  playerProfile: (id: string) => get<PlayerProfile>(`/api/v1/players/${id}/profile`),
  winprob: () => get<{ cells: WinprobCell[] }>('/api/v1/winprob'),
  playerHeatmap: (id: string, p: URLSearchParams) =>
    get<MatchHeatmap>(`/api/v1/players/${id}/heatmap?` + p),
  report: (teamId: string, map: string, since = '', roster = 0) =>
    get<ReportResp>(`/api/v1/report?team_id=${teamId}&map=${encodeURIComponent(map)}&since=${since}&roster_min=${roster}`),
  roundTicks: async (id: string, n: number): Promise<RoundTicks> => {
    if (isStatic) await ensureBundle(id);
    if (localIds.has(id)) {
      const r = await getLocalRound(id, n);
      if (r) return r;
    }
    return get<RoundTicks>(`/api/v1/rounds/${id}/${n}/ticks`);
  },
  mapLayout: (map: string) => get<MapLayout>(`/api/v1/maplayout?map=${map}`),
  query: (dsl: unknown) => post<QueryResult>('/api/v1/query', dsl),
  heatmap: (params: URLSearchParams) => get<HeatmapResp>('/api/v1/heatmap?' + params),
  stack: async (body: unknown): Promise<StackResp> => {
    const b = body as { rounds: { match_id: string; round_number: number }[]; align?: string; side?: string };
    // localStack tek maç içinde hizalar; maçlar-arası stack sunucu işidir
    const sameMatch = !!b.rounds?.length &&
      b.rounds.every((r) => r.match_id === b.rounds[0].match_id);
    if (isStatic) {
      if (!sameMatch) throw new Error(STATIC_UNAVAILABLE);
      await ensureBundle(b.rounds[0].match_id);
    }
    if (sameMatch && b.rounds.every((r) => localIds.has(r.match_id))) {
      const { localStack } = await import('./lib/localcompute');
      return localStack(
        b.rounds[0].match_id,
        b.rounds.map((r) => r.round_number),
        b.align ?? 'round_start',
        b.side,
      );
    }
    return post<StackResp>('/api/v1/stack', body);
  },
};
