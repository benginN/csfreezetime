import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Tendency } from '../api';

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

      {teamId && (
        <>
          <PredictWidget teamId={teamId} name={(teams.data ?? []).find((t) => t.team_id === teamId)?.name ?? ''} maps={maps} />
          <TendencyPanel teamId={teamId} name={(teams.data ?? []).find((t) => t.team_id === teamId)?.name ?? ''} />
        </>
      )}
    </>
  );
}

// Sonraki raunt tahmini (§6.2 Aşama 2): yöntem sunucuda seçilir — zamansal
// testte taban çizgiyi geçemeyen model sunulmaz; kanıt notu her zaman görünür.
function PredictWidget({ teamId, name, maps }: { teamId: string; name: string; maps: string[] }) {
  const [mapName, setMapName] = useState(maps[0] ?? '');
  const [side, setSide] = useState('T');
  const [buy, setBuy] = useState('');
  const effMap = mapName || maps[0] || '';

  const q = useQuery({
    queryKey: ['predict', teamId, effMap, side, buy],
    queryFn: () => {
      const p = new URLSearchParams({ team_id: teamId, map: effMap, side });
      if (buy) p.set('buy_type', buy);
      return api.predict(p);
    },
    enabled: !!effMap,
  });

  const methodLabel: Record<string, string> = {
    league: 'lig geneli',
    team: 'takım eğilimi',
    team_buy: 'takım + buy koşullu',
  };

  return (
    <>
      <h2>{name} — sonraki raunt tahmini</h2>
      <div className="panel">
        <div className="toolbar">
          <select value={effMap} onChange={(e) => setMapName(e.target.value)}>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={side} onChange={(e) => setSide(e.target.value)}>
            <option>T</option><option>CT</option>
          </select>
          <select value={buy} onChange={(e) => setBuy(e.target.value)}>
            <option value="">buy bilinmiyor</option>
            {['pistol', 'eco', 'semi', 'force', 'full'].map((b) => <option key={b}>{b}</option>)}
          </select>
          {q.data && (
            <span className="meta">
              yöntem: {methodLabel[q.data.method]} · {q.data.evidence.note}
            </span>
          )}
        </div>
        {(q.data?.clusters ?? []).slice(0, 4).map((c) => (
          <div key={c.cluster_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <div style={{ flex: '0 0 44px', fontVariantNumeric: 'tabular-nums' }}>
              %{Math.round(100 * c.prob)}
            </div>
            <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 10 }}>
              <div style={{ width: `${100 * c.prob}%`, height: '100%', background: '#8f6a2e', borderRadius: 3 }} />
            </div>
            <div className="meta" style={{ flex: '0 0 55%' }}>
              {c.label ?? c.top_places.slice(0, 3).map((p) => p.place).join(' → ')}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// Takım eğilimleri (§6.2): harita+taraf başına strateji kümesi olasılıkları.
// Kanıt gücü her satırda gösterilir (gözlem sayısı) — ürün etiği gereksinimi (§10).
function TendencyPanel({ teamId, name }: { teamId: string; name: string }) {
  const q = useQuery({ queryKey: ['tendencies', teamId], queryFn: () => api.tendencies(teamId) });
  if (q.isLoading) return <p className="meta">eğilimler yükleniyor…</p>;
  const rows = q.data ?? [];
  if (rows.length === 0)
    return <p className="meta">Bu takım için henüz eğilim verisi yok (ml-jobs çalıştırılmalı).</p>;

  const byMap = new Map<string, Tendency[]>();
  for (const r of rows) {
    const arr = byMap.get(r.map_name) ?? [];
    arr.push(r);
    byMap.set(r.map_name, arr);
  }

  return (
    <>
      <h2>{name} — oyun eğilimleri <span className="meta">(otomatik kümeleme; olasılıklar az veriyle lig ortalamasına çekilir)</span></h2>
      <div className="grid cards">
        {[...byMap.entries()].map(([map, list]) => (
          <div key={map} className="card">
            <div className="teams"><span>{map}</span></div>
            {(['T', 'CT'] as const).map((side) => {
              const top = list.filter((r) => r.side === side).slice(0, 3);
              if (!top.length) return null;
              return (
                <div key={side} style={{ marginTop: 8 }}>
                  <span className={`badge ${side}`}>{side}</span>{' '}
                  <span className="meta">{top[0].sample_size} raunt gözlem</span>
                  {top.map((r) => (
                    <div key={r.cluster_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <div style={{ flex: '0 0 44px', fontVariantNumeric: 'tabular-nums' }}>
                        %{Math.round(100 * r.prob)}
                      </div>
                      <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 8 }}>
                        <div style={{ width: `${100 * r.prob}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
                      </div>
                      <div className="meta" style={{ flex: '0 0 58%' }}>
                        {r.label ?? r.top_places.slice(0, 3).map((p) => p.place).join(' → ')}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
