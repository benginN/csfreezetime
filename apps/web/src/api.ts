// stats-svc API istemcisi — tüm tipler sunucu yanıtlarıyla birebir.

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
  score_b: number;
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
  teams: { id: string; name: string }[];
  players: { id: string; name: string }[];
  matches: {
    match_id: string;
    map_name: string | null;
    name: string | null;
    team_a: string | null;
    team_b: string | null;
    score_a: number;
    score_b: number;
    played_at: string | null;
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
  lower?: (boolean | null)[];
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

export interface ReportResp {
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
  conditional: {
    side: 'T' | 'CT'; buy_type: string; cluster_id: number;
    label: string | null; top_places: { place: string; weight: number }[];
    prob: number; sample_size: number;
  }[];
  setups: ReportSetup[];
  utility: ReportUtility[];
  players: ReportPlayer[];
}

export interface StackLayer {
  match_id: string;
  round_number: number;
  align_tick: number;
  skipped?: string;
  players?: { side: string; nick: string; t: number[]; rx: number[]; ry: number[]; lower?: boolean[] }[];
}

export interface StackResp {
  map_name: string;
  radar: RadarCal;
  align: string;
  layers: StackLayer[];
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j as T;
}

async function post<T>(url: string, body: unknown): Promise<T> {
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

export interface Prediction {
  method: 'league' | 'team' | 'team_buy';
  clusters: {
    cluster_id: number;
    label: string | null;
    top_places: { place: string; weight: number }[];
    prob: number;
  }[];
  evidence: { sample_size: number; note: string };
}

export const api = {
  search: (q: string) => get<SearchResult>('/api/v1/search?q=' + encodeURIComponent(q)),
  teams: () => get<Team[]>('/api/v1/teams'),
  tendencies: (teamId: string) => get<Tendency[]>(`/api/v1/teams/${teamId}/tendencies`),
  clusters: (map: string, side: string) => get<ClusterInfo[]>(`/api/v1/clusters?map=${map}&side=${side}`),
  predict: (p: URLSearchParams) => get<Prediction>('/api/v1/predict?' + p),
  matches: (teamId?: string) =>
    get<MatchSummary[]>('/api/v1/matches' + (teamId ? `?team_id=${teamId}` : '')),
  matchDetail: (id: string) => get<MatchDetail>(`/api/v1/matches/${id}`),
  matchPlayers: (id: string) =>
    get<{ player_id: string; nickname: string }[]>(`/api/v1/matches/${id}/players`),
  matchHeatmap: (id: string, p: URLSearchParams) =>
    get<MatchHeatmap>(`/api/v1/matches/${id}/heatmap?` + p),
  teamHeatmap: (id: string, p: URLSearchParams) =>
    get<MatchHeatmap>(`/api/v1/teams/${id}/heatmap?` + p),
  report: (teamId: string, map: string) =>
    get<ReportResp>(`/api/v1/report?team_id=${teamId}&map=${encodeURIComponent(map)}`),
  roundTicks: (id: string, n: number) => get<RoundTicks>(`/api/v1/rounds/${id}/${n}/ticks`),
  mapLayout: (map: string) => get<MapLayout>(`/api/v1/maplayout?map=${map}`),
  query: (dsl: unknown) => post<QueryResult>('/api/v1/query', dsl),
  heatmap: (params: URLSearchParams) => get<HeatmapResp>('/api/v1/heatmap?' + params),
  stack: (body: unknown) => post<StackResp>('/api/v1/stack', body),
};
