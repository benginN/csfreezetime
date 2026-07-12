import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { mixLabel, mixTitle } from '../lib/rounds';

// ML Lab: modellerin ne bildiğini, ne kadar iyi bildiğini ve nasıl
// sınandığını TEK sayfada gösterir. Beş panel:
//   1. envanter  — modellerin beslendiği veri hacmi
//   2. yöntem yarışı — zamansal log-loss tablosu (dürüstlük panosu)
//   3. LightGBM içgörüsü — modelin neye baktığı (özellik önemleri)
//   4. tahmin laboratuvarı — takım+rakip+harita → canlı dağılım
//   5. küme gezgini — stratejilerin kendisi
// Okunurluk ilkesi (kullanıcı geri bildirimi): her panel, ne gösterdiğini
// SADE İngilizceyle açıklar; kısaltma/terim yalnız legend'la birlikte.
const METHOD_LABEL: Record<string, string> = {
  league: 'league baseline',
  team: 'team tendency',
  team_buy: 'team + economy',
  team_vs: 'head-to-head',
  team_style: 'opponent style',
  lgbm: 'LightGBM model',
};

// yöntem sözlüğü — yarış tablosunun üstündeki legend ve her rozet
// başlığında (title) kullanılır
const METHOD_DESC: Record<string, string> = {
  league: 'Ignores the team completely: how often ANY team plays each strategy on this map & side. The bar every smarter method must beat.',
  team: 'The predicted team’s own history on this map & side, blended with the league average when data is thin (recent matches count more).',
  team_buy: 'Same as team tendency, but split by the round economy (full buy, eco, …) — teams behave very differently when poor.',
  team_vs: 'Only rounds the predicted team played against the exact opponent you pick. Sharp when there is enough history, useless when there isn’t.',
  team_style: 'Rounds against opponents whose playstyle looks similar to the selected opponent (cosine similarity of strategy profiles).',
  lgbm: 'A gradient-boosted decision-tree model (LightGBM). Sees the same information as "team + economy" but can generalize across teams with similar styles.',
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
  const lgbmRows = evalRows.filter((e) => e.lgbm_importance && Object.keys(e.lgbm_importance).length);
  const lgbmWins = evalRows.filter((e) => e.best_method === 'lgbm').length;

  return (
    <>
      <h1>🧠 ML Lab</h1>
      <p className="meta" style={{ maxWidth: 720 }}>
        This page shows <b>what the prediction models know, how good they are and
        how they are tested</b>. Everything is computed locally from the demo
        archive — no external AI services. Models re-train on every ingest and
        must win a <b>temporal test</b> (train on older rounds, predict the most
        recent ones) before they are allowed to serve you a prediction.
      </p>

      {/* 1 — envanter (kullanıcı isteğiyle sayfanın tepesinde, 2026-07-12) */}
      <h2>Data inventory</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        What the models are fed. More rounds per team &amp; map = sharper, more
        trustworthy predictions.
      </p>
      {inv && (
        <div className="grid cards" style={{ marginTop: 12 }}>
          {([
            [inv.matches, 'matches parsed'], [inv.rounds, 'rounds analyzed'],
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

      {/* 4 — tahmin laboratuvarı */}
      <h2>Prediction lab — pick a team, see what the site would predict</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        Pick a team and a situation; you get the same distribution the site would
        serve, plus <b>which method produced it and on how much evidence</b>.
        Setting an opponent switches to matchup-calibrated methods when the
        temporal test favours them: real head-to-head rounds if there are enough,
        otherwise rounds against similar-style opponents.
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
        {!teamId && <p className="meta">pick a team to see its next-round strategy distribution</p>}
        {predict.data && (
          <>
            <div className="toolbar" style={{ gap: 8 }}>
              <span className="badge gray" title={METHOD_DESC[predict.data.method]}>
                method: {METHOD_LABEL[predict.data.method] ?? predict.data.method}
              </span>
              <span className="meta">{predict.data.evidence.note}</span>
            </div>
            {(predict.data.clusters ?? []).slice(0, 6).map((c) => (
              <Bar key={c.cluster_id} prob={c.prob}
                label={c.label ?? mixLabel(c.top_places)} title={mixTitle(c.top_places)} />
            ))}
          </>
        )}
        {teamId && (
          <p className="meta" style={{ marginTop: 8 }}>
            fallback chain: LightGBM → head-to-head → opponent style → team + economy
            → team → league — each step only serves where it won the temporal test.
            {teamId && <> · <Link to={`/report/${teamId}?map=${effMap}`}>full opponent report →</Link></>}
          </p>
        )}
      </div>

      {/* 2 — yöntem yarışı */}
      <h2>Method race — which prediction method earns the right to be shown?</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        Every method is a different way of answering one question: <i>“which
        strategy will team X play next round?”</i> — pick any team in the
        prediction lab above to see the answers live. Here the six methods are
        scored against each other with{' '}
        <b title="For every test round: how much probability did the method give to the strategy that actually happened? Less surprise = lower score.">
          log-loss
        </b>{' '}
        — think of it as <i>“how surprised was the method by what actually
        happened”</i>, so <b>lower is better</b>. The test is honest: methods only
        see older rounds and must predict the newest 25% of every match.
        The <span style={{ fontWeight: 700, color: '#8fd39a' }}>green</span> value
        wins that row, and <b>only the winner is ever shown on the site</b>.
      </p>
      <div className="grid cards" style={{ margin: '10px 0' }}>
        {Object.entries(METHOD_DESC).map(([m, desc]) => (
          <div key={m} className="card" style={{ padding: '8px 10px' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{METHOD_LABEL[m]}</div>
            <div className="meta" style={{ fontSize: 12 }}>{desc}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>map / side</th>
              {(['league', 'team', 'team_buy', 'team_vs', 'team_style', 'lgbm'] as const).map((m) => (
                <th key={m} title={METHOD_DESC[m]}>{METHOD_LABEL[m]}</th>
              ))}
              <th>served method</th>
              <th className="meta" title="how many recent rounds each method was tested on">test n</th>
            </tr>
          </thead>
          <tbody>
            {evalRows.map((e) => {
              const vals: [string, number | null][] = [
                ['league', e.logloss_league], ['team', e.logloss_team],
                ['team_buy', e.logloss_team_buy], ['team_vs', e.logloss_team_vs],
                ['team_style', e.logloss_team_style], ['lgbm', e.logloss_lgbm],
              ];
              return (
                <tr key={e.map_name + e.side}>
                  <td>{e.map_name.replace('de_', '')} <span className={`badge ${e.side}`}>{e.side}</span></td>
                  {vals.map(([m, v]) => (
                    <td key={m} style={m === e.best_method ? { fontWeight: 700, color: '#8fd39a' } : undefined}>
                      {v != null ? v.toFixed(3) : '—'}
                    </td>
                  ))}
                  <td>
                    <span className="badge gray" title={METHOD_DESC[e.best_method]}>
                      {METHOD_LABEL[e.best_method] ?? e.best_method}
                    </span>
                  </td>
                  <td className="meta">{e.test_rounds ?? '—'}</td>
                </tr>
              );
            })}
            {!evalRows.length && (
              <tr><td colSpan={9} className="meta">no evaluation yet — run ml-jobs</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 3 — LightGBM içgörüsü */}
      <h2>LightGBM insight — what does the model look at?</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        LightGBM is the only <i>learned</i> model in the race (the others are
        transparent counting + smart averaging). It currently wins{' '}
        <b>{lgbmWins} of {evalRows.length}</b> map/side combinations
        {lgbmWins === 0 && ' — the honest baselines are still better, so it is not shown anywhere on the site yet'}.
        Where it wins, the bars below show <b>which inputs drive its decisions</b>{' '}
        (share of total decision power, from tree gain).
      </p>
      {lgbmRows.length > 0 ? (
        <div className="grid cards">
          {lgbmRows.map((e) => {
            // ham özellik önemleri üç anlaşılır bileşene toplanır
            let eco = 0, hist = 0, finger = 0;
            for (const [k2, v] of Object.entries(e.lgbm_importance!)) {
              if (k2 === 'buy_type') eco += v;
              else if (k2 === 'log_n_eff') hist += v;
              else finger += v; // own_share_* → takımın strateji parmak izi
            }
            const parts: [string, number][] = ([
              ['the round economy (what they can afford)', eco],
              ['the team’s strategy fingerprint (what they historically run)', finger],
              ['how much history there is (evidence volume)', hist],
            ] as [string, number][]).sort((a, b) => b[1] - a[1]);
            return (
              <div key={e.map_name + e.side} className="card">
                <div className="teams">
                  <span>{e.map_name.replace('de_', '')} <span className={`badge ${e.side}`}>{e.side}</span></span>
                  {e.best_method === 'lgbm' && <span className="badge gray" title="this is what the site serves for this map & side">live</span>}
                </div>
                <p className="meta" style={{ margin: '6px 0' }}>
                  Decides mostly by <b>{parts[0][0]}</b> ({Math.round(100 * parts[0][1])}%),
                  then by {parts[1][0]} ({Math.round(100 * parts[1][1])}%).
                </p>
                {parts.map(([name, v]) => (
                  <Bar key={name} prob={v} label={name} />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="meta">
          No winning map/side yet — importance charts appear here once LightGBM
          beats the baseline somewhere. It re-enters the race on every archive
          update, so this can change as data grows.
        </p>
      )}

      {/* 5 — küme gezgini */}
      <h2>Strategy cluster explorer — what are these “strategies” anyway?</h2>
      <p className="meta" style={{ maxWidth: 720 }}>
        A <b>strategy cluster</b> is a recurring way a side opens a round —
        found automatically by grouping rounds whose players occupy similar map
        areas in the opening phase (k-means). The route shows the dominant map
        areas; ▶ opens a real example round in the replay viewer. Name the
        clusters on the Analyze page ✏ — labels show up everywhere.
      </p>
      <div className="panel">
        <div className="toolbar">
          <select value={effCMap} onChange={(e) => setCMap(e.target.value)}>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={cSide} onChange={(e) => setCSide(e.target.value)}>
            <option>T</option><option>CT</option>
          </select>
        </div>
        <div className="grid cards">
          {(clusters.data ?? []).map((c) => (
            <div key={c.cluster_id} className="card">
              <div className="teams">
                <span>#{c.cluster_id} {c.label ?? <span className="meta">(unlabeled)</span>}</span>
                <span className="meta">{c.size} rounds</span>
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                <span title={mixTitle(c.top_places)}>{mixLabel(c.top_places, 4)}</span>
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

function Bar({ prob, label, title }: { prob: number; label: string; title?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{ flex: '0 0 42px', fontVariantNumeric: 'tabular-nums' }}>%{Math.round(100 * prob)}</div>
      <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 9 }}>
        <div style={{ width: `${100 * prob}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
      </div>
      <div className="meta" style={{ flex: '0 0 55%' }} title={title}>{label}</div>
    </div>
  );
}
