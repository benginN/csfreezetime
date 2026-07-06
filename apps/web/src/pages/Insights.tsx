import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

// ML Lab: modellerin ne bildiğini, ne kadar iyi bildiğini ve nasıl
// sınandığını TEK sayfada gösterir. Dört panel:
//   1. envanter  — modellerin beslendiği veri hacmi
//   2. yöntem yarışı — zamansal log-loss tablosu (dürüstlük panosu)
//   3. tahmin laboratuvarı — takım+rakip+harita → canlı dağılım
//   4. küme gezgini — stratejilerin kendisi
const METHOD_LABEL: Record<string, string> = {
  league: 'league baseline',
  team: 'team tendency',
  team_buy: 'team + buy',
  team_vs: 'head-to-head',
  team_style: 'opponent style',
};

export default function Insights() {
  const status = useQuery({ queryKey: ['mlstatus'], queryFn: () => api.mlStatus() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.teams() });

  const maps = useMemo(
    () => [...new Set((status.data?.evaluation ?? []).map((e) => e.map_name))].sort(),
    [status.data],
  );
  const teamList = useMemo(
    () => (teams.data ?? []).filter((t) => t.matches > 0).sort((a, b) => a.name.localeCompare(b.name)),
    [teams.data],
  );

  // --- tahmin laboratuvarı durumu ---
  const [teamId, setTeamId] = useState('');
  const [oppId, setOppId] = useState('');
  const [mapName, setMapName] = useState('');
  const [side, setSide] = useState('T');
  const [buy, setBuy] = useState('');
  const effMap = mapName || maps[0] || '';

  const predict = useQuery({
    queryKey: ['predict', teamId, oppId, effMap, side, buy],
    queryFn: () => {
      const p = new URLSearchParams({ team_id: teamId, map: effMap, side });
      if (buy) p.set('buy_type', buy);
      if (oppId) p.set('opp_id', oppId);
      return api.predict(p);
    },
    enabled: !!teamId && !!effMap,
  });

  // --- küme gezgini durumu ---
  const [cMap, setCMap] = useState('');
  const [cSide, setCSide] = useState('T');
  const effCMap = cMap || maps[0] || '';
  const clusters = useQuery({
    queryKey: ['clusters', effCMap, cSide],
    queryFn: () => api.clusters(effCMap, cSide),
    enabled: !!effCMap,
  });

  const inv = status.data?.inventory;
  const evalRows = status.data?.evaluation ?? [];

  return (
    <>
      <h1>🧠 ML Lab</h1>
      <p className="meta" style={{ maxWidth: 720 }}>
        Everything here is computed locally from the demo archive — no external
        AI services. Models re-train on every ingest and must beat the league
        baseline on a <b>temporal test</b> (train on the past, test on the most
        recent rounds) before they are allowed to serve predictions.
      </p>

      {/* 1 — envanter */}
      {inv && (
        <div className="grid cards" style={{ marginTop: 12 }}>
          {([
            [inv.matches, 'matches'], [inv.rounds, 'rounds'],
            [inv.clusters, 'strategy clusters'], [inv.tendency_rows, 'team tendencies'],
            [inv.vs_rows, 'opponent-calibrated rows'], [inv.winprob_cells, 'win-prob states'],
            [inv.anomaly_flags, 'anomaly flags'], [inv.exec_templates, 'execute templates'],
            [inv.clutches, 'clutch situations'],
          ] as [number, string][]).map(([n, label]) => (
            <div key={label} className="card" style={{ textAlign: 'center', padding: '10px 6px' }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{n.toLocaleString('en-US')}</div>
              <div className="meta">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* 2 — yöntem yarışı */}
      <h2>Model race — temporal log-loss (lower is better)</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        Five methods compete per map &amp; side. <b>Bold</b> is the winner and is
        what the site actually serves. A method that cannot beat the baseline is
        never shown to you — that is the honesty rule.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>map / side</th>
              <th>league</th><th>team</th><th>team+buy</th>
              <th>head-to-head</th><th>opp. style</th>
              <th>winner</th><th className="meta">test n</th>
            </tr>
          </thead>
          <tbody>
            {evalRows.map((e) => {
              const vals: [string, number | null][] = [
                ['league', e.logloss_league], ['team', e.logloss_team],
                ['team_buy', e.logloss_team_buy], ['team_vs', e.logloss_team_vs],
                ['team_style', e.logloss_team_style],
              ];
              return (
                <tr key={e.map_name + e.side}>
                  <td>{e.map_name.replace('de_', '')} <span className={`badge ${e.side}`}>{e.side}</span></td>
                  {vals.map(([m, v]) => (
                    <td key={m} style={m === e.best_method ? { fontWeight: 700, color: '#8fd39a' } : undefined}>
                      {v != null ? v.toFixed(3) : '—'}
                    </td>
                  ))}
                  <td><span className="badge gray">{METHOD_LABEL[e.best_method] ?? e.best_method}</span></td>
                  <td className="meta">{e.test_rounds ?? '—'}</td>
                </tr>
              );
            })}
            {!evalRows.length && (
              <tr><td colSpan={8} className="meta">no evaluation yet — run ml-jobs</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 3 — tahmin laboratuvarı */}
      <h2>Prediction lab</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        Pick a team and (optionally) an opponent. When an opponent is set and the
        temporal test favours it, the distribution is calibrated to that matchup:
        real head-to-head rounds when there are enough, otherwise rounds against
        opponents with a <i>similar style profile</i>.
      </p>
      <div className="panel">
        <div className="toolbar">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">team…</option>
            {teamList.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
          </select>
          <span className="meta">vs</span>
          <select value={oppId} onChange={(e) => setOppId(e.target.value)}>
            <option value="">any opponent</option>
            {teamList.filter((t) => t.team_id !== teamId)
              .map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
          </select>
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
        </div>
        {!teamId && <p className="meta">pick a team to see its next-round distribution</p>}
        {predict.data && (
          <>
            <div className="toolbar" style={{ gap: 8 }}>
              <span className="badge gray">method: {METHOD_LABEL[predict.data.method] ?? predict.data.method}</span>
              <span className="meta">{predict.data.evidence.note}</span>
            </div>
            {(predict.data.clusters ?? []).slice(0, 6).map((c) => (
              <Bar key={c.cluster_id} prob={c.prob}
                label={c.label ?? c.top_places.slice(0, 3).map((p) => p.place).join(' → ')} />
            ))}
          </>
        )}
        {teamId && (
          <p className="meta" style={{ marginTop: 8 }}>
            fallback chain: head-to-head → opponent style → team {buy ? '→ team+buy ' : ''}→ league —
            each step only serves if it won the temporal test.
            {teamId && <> · <Link to={`/report/${teamId}?map=${effMap}`}>full opponent report →</Link></>}
          </p>
        )}
      </div>

      {/* 4 — küme gezgini */}
      <h2>Strategy cluster explorer</h2>
      <div className="panel">
        <div className="toolbar">
          <select value={effCMap} onChange={(e) => setCMap(e.target.value)}>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={cSide} onChange={(e) => setCSide(e.target.value)}>
            <option>T</option><option>CT</option>
          </select>
          <span className="meta">
            k-means over opening-phase positioning; label them on the Analyze page ✏
          </span>
        </div>
        <div className="grid cards">
          {(clusters.data ?? []).map((c) => (
            <div key={c.cluster_id} className="card">
              <div className="teams">
                <span>#{c.cluster_id} {c.label ?? <span className="meta">(unlabeled)</span>}</span>
                <span className="meta">{c.size} rounds</span>
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                {c.top_places.slice(0, 4).map((p) => p.place).join(' → ') || 'no dominant route'}
              </div>
              {(c.representatives ?? []).slice(0, 2).map((r2) => (
                <div key={r2.match_id + r2.round_number} style={{ marginTop: 4 }}>
                  <Link to={`/match/${r2.match_id}?round=${r2.round_number}`} className="meta">
                    ▶ example round {r2.round_number}
                  </Link>
                </div>
              ))}
            </div>
          ))}
          {!clusters.data?.length && <p className="meta">no clusters for this map/side yet</p>}
        </div>
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
