import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type RoundRow } from '../api';
import { drawMapBase, hidpiCtx, loadMapBase, type MapBase } from '../lib/mapbase';
import { paintHeat } from '../lib/heatpaint';
import { chipTitle, isSideSwap, winnerTeamClass } from '../lib/rounds';

const HW = 720;

export default function HeatView({
  matchId, mapName, rounds, teams,
}: {
  matchId: string;
  mapName: string;
  rounds: RoundRow[];
  teams: { aId: string | null; a: string | null; b: string | null };
}) {
  const [side, setSide] = useState('T');
  const [player, setPlayer] = useState('');
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(115);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(rounds.map((r) => r.round_number)), // varsayılan: tüm rauntlar
  );
  const [base, setBase] = useState<MapBase | null>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { loadMapBase(mapName).then(setBase); }, [mapName]);

  const players = useQuery({
    queryKey: ['matchPlayers', matchId],
    queryFn: () => api.matchPlayers(matchId),
  });

  const roundKey = useMemo(() => [...selected].sort((a, b) => a - b).join(','), [selected]);
  const heat = useQuery({
    queryKey: ['matchHeat', matchId, side, player, roundKey, t0, t1],
    queryFn: () => {
      const p = new URLSearchParams({ t0: String(Math.min(t0, t1)), t1: String(Math.max(t0, t1)) });
      if (side) p.set('side', side);
      if (player) p.set('player_id', player);
      p.set('rounds', roundKey);
      return api.matchHeatmap(matchId, p);
    },
    enabled: selected.size > 0,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !base) return;
    const ctx = hidpiCtx(cv, HW);
    drawMapBase(ctx, HW, base, true);
    if (heat.data) paintHeat(ctx, HW, base, heat.data);
  }, [heat.data, base]);

  const allSelected = selected.size === rounds.length;

  return (
    <>
      <div className="roundchips">
        {rounds.map((r, i) => (
          <Fragment key={r.round_number}>
            {isSideSwap(rounds[i - 1], r) && <span className="halfdiv" title="side swap" />}
            <button
              className={`${winnerTeamClass(r, teams.aId)} win${r.winner_side ?? ''} ${selected.has(r.round_number) ? 'sel' : ''}`}
              onClick={() => {
                const s = new Set(selected);
                if (s.has(r.round_number)) s.delete(r.round_number);
                else s.add(r.round_number);
                setSelected(s);
              }}
              title={chipTitle(r, teams)}
            >
              {r.round_number}
            </button>
          </Fragment>
        ))}
        <button
          className="ghost"
          style={{ width: 'auto', padding: '0 8px' }}
          onClick={() => setSelected(allSelected ? new Set() : new Set(rounds.map((r) => r.round_number)))}
        >
          {allSelected ? 'None' : 'All'}
        </button>
      </div>
      <div className="toolbar">
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option>T</option><option>CT</option><option value="">both sides</option>
        </select>
        <select value={player} onChange={(e) => setPlayer(e.target.value)}>
          <option value="">all players</option>
          {(players.data ?? []).map((p) => (
            <option key={p.player_id} value={p.player_id}>{p.nickname}</option>
          ))}
        </select>
        <label>{Math.min(t0, t1)}–{Math.max(t0, t1)} s into round</label>
        <input type="range" min={0} max={115} value={t0} onChange={(e) => setT0(Number(e.target.value))} style={{ width: 160 }} />
        <input type="range" min={0} max={115} value={t1} onChange={(e) => setT1(Number(e.target.value))} style={{ width: 160 }} />
        <span className="meta">
          {selected.size === 0 ? 'pick rounds above' :
            heat.isFetching ? 'computing…' :
            heat.data && heat.data.cells.length === 0 ?
              'no data for this combination (was the player on this side in these rounds?)' :
            heat.data ? `${heat.data.round_count} rounds` : ''}
        </span>
        {heat.error && <span className="error">{String(heat.error)}</span>}
      </div>
      <canvas ref={cvRef} className="flat" width={HW} height={HW} />
    </>
  );
}
