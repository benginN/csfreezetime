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
}

export interface KillRow {
  round_number: number;
  tick: number;
  round_time: number;
  attacker: string | null;
  victim: string | null;
  weapon: string | null;
  headshot: boolean | null;
}

export interface MatchDetail {
  match_id: string;
  map_name: string | null;
  status: string;
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
  alive: (boolean | null)[];
  weapon: (string | null)[];
  flash: (number | null)[];
  lower?: (boolean | null)[];
}

export interface KillMark {
  tick: number;
  attacker: string | null;
  victim: string | null;
  weapon: string | null;
  victim_rx: number | null;
  victim_ry: number | null;
}

export interface GrenadeMark {
  type: 'smoke' | 'molotov' | 'incendiary' | 'flash' | 'he' | 'decoy';
  tick: number;
  side: string | null;
  thrower: string | null;
  rx: number | null;
  ry: number | null;
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

export interface StackLayer {
  match_id: string;
  round_number: number;
  align_tick: number;
  skipped?: string;
  players?: { side: string; t: number[]; rx: number[]; ry: number[] }[];
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

export const api = {
  teams: () => get<Team[]>('/api/v1/teams'),
  matches: (teamId?: string) =>
    get<MatchSummary[]>('/api/v1/matches' + (teamId ? `?team_id=${teamId}` : '')),
  matchDetail: (id: string) => get<MatchDetail>(`/api/v1/matches/${id}`),
  roundTicks: (id: string, n: number) => get<RoundTicks>(`/api/v1/rounds/${id}/${n}/ticks`),
  mapLayout: (map: string) => get<MapLayout>(`/api/v1/maplayout?map=${map}`),
  query: (dsl: unknown) => post<QueryResult>('/api/v1/query', dsl),
  heatmap: (params: URLSearchParams) => get<HeatmapResp>('/api/v1/heatmap?' + params),
  stack: (body: unknown) => post<StackResp>('/api/v1/stack', body),
};
