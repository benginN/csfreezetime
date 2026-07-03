import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export default function Matches() {
  const [teamId, setTeamId] = useState('');
  const [mapName, setMapName] = useState('');

  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const matches = useQuery({
    queryKey: ['matches', teamId],
    queryFn: () => api.matches(teamId || undefined),
  });

  const maps = [...new Set((matches.data ?? []).map((m) => m.map_name).filter(Boolean))] as string[];
  const list = (matches.data ?? []).filter(
    (m) => m.status === 'ready' && (!mapName || m.map_name === mapName),
  );

  return (
    <>
      <h1>Maçlar</h1>
      <div className="toolbar">
        <label>Takım</label>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">Tümü</option>
          {(teams.data ?? []).map((t) => (
            <option key={t.team_id} value={t.team_id}>
              {t.name} ({t.matches} maç)
            </option>
          ))}
        </select>
        <label>Harita</label>
        <select value={mapName} onChange={(e) => setMapName(e.target.value)}>
          <option value="">Tümü</option>
          {maps.sort().map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        {matches.isLoading && <span className="meta">yükleniyor…</span>}
        {matches.error && <span className="error">{String(matches.error)}</span>}
      </div>

      <div className="grid cards">
        {list.map((m) => (
          <Link key={m.match_id} to={`/match/${m.match_id}`} className="card">
            <div className="teams">
              <span>{m.team_a ?? 'Takım A'}</span>
              <span className="score">
                {m.score_a} : {m.score_b}
              </span>
              <span>{m.team_b ?? 'Takım B'}</span>
            </div>
            <div className="meta">
              {m.map_name} · {m.rounds} raunt{m.name ? ` · ${m.name}` : ''}
            </div>
          </Link>
        ))}
      </div>
      {!matches.isLoading && list.length === 0 && (
        <p className="meta">Filtreye uyan maç yok.</p>
      )}
    </>
  );
}
