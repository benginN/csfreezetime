import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Tendency } from '../api';
import { useMemo, useRef, useState } from 'react';
import { teamHue, teamInitials } from '../lib/rounds';

export default function Home() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';

  const res = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q),
    placeholderData: (prev) => prev, // yazarken liste titremesin
  });

  const matches = groupParts(res.data?.matches ?? []);
  const teams = res.data?.teams ?? [];
  // Sorgu tek takıma denk düşüyorsa altta eğilim + tahmin blokları
  const soloTeam = q.trim() && teams.length === 1 ? teams[0] : null;

  return (
    <>
      {!q.trim() && <TeamStrip />}
      {(res.data?.teams ?? []).length > 0 && q.trim() && (
        <div className="toolbar">
          <span className="meta">teams:</span>
          {(res.data?.teams ?? []).map((t) => (
            <Link key={t.id} to={`/team/${t.id}`}>
              <button className="ghost">
                <span className="monogram sm" style={{ background: `hsl(${teamHue(t.name)},45%,32%)` }}>
                  {teamInitials(t.name)}
                </span>{' '}
                {t.name}
              </button>
            </Link>
          ))}
        </div>
      )}
      {(res.data?.players ?? []).length > 0 && q.trim() && (
        <div className="toolbar">
          <span className="meta">players:</span>
          {(res.data?.players ?? []).map((p) => (
            <Link key={p.id} to={`/player/${p.id}`}>
              <button className="ghost">👤 {p.name}</button>
            </Link>
          ))}
        </div>
      )}
      <div className="meta" style={{ margin: '4px 0 12px' }}>
        {res.isLoading ? 'searching…'
          : q ? `${matches.length} matches · “${q}”`
          : `(total of ${res.data?.total ?? '…'} matches) most recent 100 matches — search to reach the entire database`}
      </div>

      {matches.map((m) => (
        <Link key={m.match_id} to={`/match/${m.match_id}`} className="matchrow">
          <span className="vs">
            <span>{m.team_a ?? 'Team A'}</span>
            <span className="score">{m.score_a} : {m.score_b}</span>
            <span>{m.team_b ?? 'Team B'}</span>
          </span>
          <span className="badge gray">{m.map_name}</span>
          {m.parts > 1 && (
            <span className="badge gray" title="the GOTV recording was split mid-map; parts play separately, the score here is combined">
              {m.parts} parts
            </span>
          )}
          {m.tournament && <span className="meta cut" style={{ maxWidth: 220 }}>🏆 {m.tournament.replace(/-/g, ' ')}</span>}
          <span className="meta">{m.played_at ?? ''}</span>
        </Link>
      ))}
      {!res.isLoading && matches.length === 0 && (
        <p className="meta">No results — try a team, player or map name.</p>
      )}

      {soloTeam && <TeamPanels teamId={soloTeam.id} name={soloTeam.name} />}
    </>
  );
}

// Ana sayfa takım şeridi: monogram "logo" + ad; tıklayınca takım anasayfası.
// Ana sayfa takım şeridi: alfabetik, tek satır, yatay kaydırmalı
// (dikey teker de yatay kaydırır; kenar solmaları devamı ima eder).
function TeamStrip() {
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.teams() });
  const ref = useRef<HTMLDivElement>(null);
  const list = (teams.data ?? [])
    .filter((t) => t.matches > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return null;
  return (
    <div className="stripwrap">
      <div
        ref={ref}
        className="teamstrip scrollrow"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && ref.current) {
            ref.current.scrollLeft += e.deltaY;
          }
        }}
      >
        {list.map((t) => (
          <Link key={t.team_id} to={`/team/${t.team_id}`} className="teamcard">
            <span className="monogram" style={{ background: `hsl(${teamHue(t.name)},45%,32%)` }}>
              {teamInitials(t.name)}
            </span>
            <span>
              <span className="tname">{t.name}</span>
              <span className="meta">{t.matches} matches</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function TeamPanels({ teamId, name }: { teamId: string; name: string }) {
  const tendencies = useQuery({
    queryKey: ['tendencies', teamId],
    queryFn: () => api.tendencies(teamId),
  });
  const maps = useMemo(
    () => [...new Set((tendencies.data ?? []).map((t) => t.map_name))].sort(),
    [tendencies.data],
  );
  const [mapName, setMapName] = useState('');
  const [side, setSide] = useState('T');
  const [buy, setBuy] = useState('');
  const effMap = mapName || maps[0] || '';

  const predict = useQuery({
    queryKey: ['predict', teamId, effMap, side, buy],
    queryFn: () => {
      const p = new URLSearchParams({ team_id: teamId, map: effMap, side });
      if (buy) p.set('buy_type', buy);
      return api.predict(p);
    },
    enabled: !!effMap,
  });

  if (!maps.length) return null;
  const methodLabel: Record<string, string> = {
    league: 'league-wide', team: 'team tendency', team_buy: 'team + buy conditional',
  };

  const byMap = new Map<string, Tendency[]>();
  for (const r of tendencies.data ?? []) {
    const arr = byMap.get(r.map_name) ?? [];
    arr.push(r);
    byMap.set(r.map_name, arr);
  }

  return (
    <>
      <h2>
        {name} — next round prediction{' '}
        <Link to={`/report/${teamId}`} style={{ fontWeight: 400 }}>· Full opponent report →</Link>
      </h2>
      <div className="panel">
        <div className="toolbar">
          <select value={effMap} onChange={(e) => setMapName(e.target.value)}>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={side} onChange={(e) => setSide(e.target.value)}>
            <option>T</option><option>CT</option>
          </select>
          <select value={buy} onChange={(e) => setBuy(e.target.value)}>
            <option value="">buy unknown</option>
            {['pistol', 'eco', 'semi', 'force', 'full'].map((b) => <option key={b}>{b}</option>)}
          </select>
          {predict.data && (
            <span className="meta">
              method: {methodLabel[predict.data.method]} · {predict.data.evidence.note}
            </span>
          )}
        </div>
        {(predict.data?.clusters ?? []).slice(0, 4).map((c) => (
          <Bar key={c.cluster_id} prob={c.prob}
            label={c.label ?? c.top_places.slice(0, 3).map((p) => p.place).join(' → ')} />
        ))}
      </div>

      <h2>{name} — map tendencies</h2>
      <div className="grid cards">
        {[...byMap.entries()].map(([map, list]) => (
          <div key={map} className="card">
            <div className="teams"><span>{map}</span></div>
            {(['T', 'CT'] as const).map((s) => {
              const top = list.filter((r) => r.side === s).slice(0, 3);
              if (!top.length) return null;
              return (
                <div key={s} style={{ marginTop: 8 }}>
                  <span className={`badge ${s}`}>{s}</span>{' '}
                  <span className="meta">{top[0].sample_size} rounds observed</span>
                  {top.map((r) => (
                    <Bar key={r.cluster_id} prob={r.prob}
                      label={r.label ?? r.top_places.slice(0, 3).map((p) => p.place).join(' → ')} />
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

function Bar({ prob, label }: { prob: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{ flex: '0 0 42px', fontVariantNumeric: 'tabular-nums' }}>%{Math.round(100 * prob)}</div>
      <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 9 }}>
        <div style={{ width: `${100 * prob}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
      </div>
      <div className="meta" style={{ flex: '0 0 55%' }}>{label}</div>
    </div>
  );
}


// GOTV kesintisiyle bölünen kayıtlar (…-p1/-p2) listede TEK satır olur:
// skorlar toplanır, link ilk parçaya gider. (Gerçek DB birleştirme, çok
// demolu maç şeması ile yayına hazırlık fazında.)
interface MatchHit {
  match_id: string; name: string | null;
  score_a: number; score_b: number;
}
function groupParts<T extends MatchHit>(list: T[]): (T & { parts: number })[] {
  const out: (T & { parts: number })[] = [];
  const byBase = new Map<string, T & { parts: number }>();
  for (const m of list) {
    const pm = /^(.*)-p(\d)$/.exec(m.name ?? '');
    if (!pm) {
      out.push({ ...m, parts: 1 });
      continue;
    }
    const key = pm[1];
    const cur = byBase.get(key);
    if (!cur) {
      const row = { ...m, parts: 1 };
      byBase.set(key, row);
      out.push(row);
    } else {
      cur.parts += 1;
      cur.score_a += m.score_a;
      cur.score_b += m.score_b;
      if (Number(pm[2]) === 1) cur.match_id = m.match_id; // link ilk parçaya
    }
  }
  return out;
}
