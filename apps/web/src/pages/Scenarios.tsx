import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { mixLabel, mixTitle } from '../lib/rounds';
import { MlMark } from '../lib/MlMark';

// Senaryo Laboratuvarı: Moments'ın takım-analizi kardeşi — "full buy'da,
// A'da kaybettikleri raundun ertesinde ne oynuyorlar?" gibi koşullu
// sorular. Sonuç = o durumdaki tarihi dağılım + takımın normaline göre
// sapma (lift) + örnek rauntlar. Okunurluk ilkesi: her kontrol düz dille.
export default function Scenarios() {
  const status = useQuery({ queryKey: ['mlstatus'], queryFn: () => api.mlStatus() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.teams() });
  const maps = useMemo(
    () => [...new Set((status.data?.evaluation ?? []).map((e) => e.map_name))].sort(),
    [status.data],
  );
  const teamList = useMemo(
    () => (teams.data ?? []).filter((t) => t.matches > 0)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [teams.data],
  );

  const [teamId, setTeamId] = useState('');
  const [mapName, setMapName] = useState('');
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const [buy, setBuy] = useState('');
  const [prev, setPrev] = useState('');
  const [prevSite, setPrevSite] = useState('');
  const [rclass, setRclass] = useState('');
  const effMap = mapName || maps[0] || '';

  const sc = useQuery({
    queryKey: ['scenario', teamId, effMap, side, buy, prev, prevSite, rclass],
    queryFn: () => {
      const p = new URLSearchParams({ team_id: teamId, map: effMap, side });
      if (buy) p.set('buy', buy);
      if (prev) p.set('prev', prev);
      if (prevSite) p.set('prev_site', prevSite);
      if (rclass) p.set('rclass', rclass);
      return api.scenario(p);
    },
    enabled: !!teamId && !!effMap,
  });
  const d = sc.data;

  // seçilen senaryonun düz-dil özeti (başlık cümlesi)
  const sentence = useMemo(() => {
    const bits: string[] = [];
    if (rclass) bits.push(`on ${rclass} rounds`);
    if (buy) bits.push(`with a ${buy} buy`);
    if (prev === 'lost') bits.push('right after LOSING a round');
    if (prev === 'won') bits.push('right after winning a round');
    if (prevSite === 'A' || prevSite === 'B') bits.push(`that ended on ${prevSite}`);
    if (prevSite === 'none') bits.push('that had no plant');
    return bits.length ? bits.join(', ') : 'in any situation';
  }, [buy, prev, prevSite, rclass]);

  return (
    <>
      <h1>🔬 Scenarios <MlMark note="Historical distribution under your chosen conditions, compared against the team's overall habits — straight counting with sample sizes, powered by the ML strategy clusters." /></h1>
      <p className="meta" style={{ maxWidth: 760 }}>
        Ask situation questions about a team, like a moment search for
        tendencies: <i>“what do they run on a full buy, right after losing a
        round on A?”</i> Pick the situation below — you get what they
        historically ran in exactly that spot, <b>how different it is from
        their normal game</b> (×N = that many times more than usual), and real
        rounds to watch.
      </p>

      <div className="toolbar">
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">team…</option>
          {teamList.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
        </select>
        <select value={effMap} onChange={(e) => setMapName(e.target.value)}>
          {maps.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
          <option>T</option><option>CT</option>
        </select>
      </div>
      <div className="toolbar">
        <select value={buy} onChange={(e) => setBuy(e.target.value)} title="the team's own economy this round">
          <option value="">any buy</option>
          {['pistol', 'eco', 'force', 'semi', 'full'].map((b) => <option key={b}>{b}</option>)}
        </select>
        <select value={prev} onChange={(e) => setPrev(e.target.value)} title="what happened to THEM in the previous round">
          <option value="">previous round: any</option>
          <option value="won">after a won round</option>
          <option value="lost">after a lost round</option>
        </select>
        <select value={prevSite} onChange={(e) => setPrevSite(e.target.value)} title="where the previous round ended">
          <option value="">prev. ended: anywhere</option>
          <option value="A">…on A</option>
          <option value="B">…on B</option>
          <option value="none">…no plant</option>
        </select>
        <select value={rclass} onChange={(e) => setRclass(e.target.value)} title="which part of the half">
          <option value="">any round type</option>
          {['pistol', 'after pistol', '3rd round', 'mid-game', 'overtime'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      {!teamId && <p className="meta">pick a team to start asking questions</p>}
      {d && teamId && (
        <div className="panel">
          <p style={{ marginTop: 0 }}>
            <b>{teamList.find((t) => t.team_id === teamId)?.name}</b> as {side} on{' '}
            {effMap.replace('de_', '')}, {sentence}:{' '}
            <span className="meta">
              {d.n} matching rounds{d.n < 10 && d.n > 0 ? ' — small sample, treat with caution ⚠' : ''}
            </span>
          </p>
          {d.n === 0 && <p className="meta">no rounds match — loosen a filter</p>}
          {d.rows.filter((r) => r.n > 0).map((r) => (
            <div key={r.cluster_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <div style={{ flex: '0 0 42px', fontVariantNumeric: 'tabular-nums' }}>
                %{Math.round(100 * r.share)}
              </div>
              <div style={{ flex: 1, background: '#232a26', borderRadius: 3, height: 9 }}>
                <div style={{ width: `${100 * r.share}%`, height: '100%', background: '#4c8f52', borderRadius: 3 }} />
              </div>
              <div className="meta" style={{ flex: '0 0 42%' }} title={mixTitle(r.top_places)}>
                {r.label ?? mixLabel(r.top_places)}
                <span className="meta"> · n={r.n}</span>
              </div>
              <div style={{ flex: '0 0 110px', textAlign: 'right' }}>
                {r.lift >= 1.4 && (
                  <span style={{ color: '#8fd39a' }} title={`usually ${Math.round(100 * r.base_share)}% of their rounds — in this scenario ${Math.round(100 * r.share)}%`}>
                    ×{r.lift.toFixed(1)} vs usual
                  </span>
                )}
                {r.lift > 0 && r.lift <= 0.6 && (
                  <span style={{ color: '#e0a585' }} title={`usually ${Math.round(100 * r.base_share)}% — they drop it in this scenario`}>
                    {r.lift.toFixed(1)}× vs usual
                  </span>
                )}
              </div>
            </div>
          ))}
          {d.reps.length > 0 && (
            <p className="meta" style={{ marginTop: 10 }}>
              watch it: {d.reps.map((rp, i) => (
                <span key={i}>{i > 0 && ' · '}
                  <Link to={`/match/${rp.match_id}?round=${rp.round_number}`}>▶ r{rp.round_number}</Link>
                </span>
              ))}
            </p>
          )}
          {teamId && (
            <p className="meta" style={{ marginTop: 8 }}>
              <Link to={`/report/${teamId}?map=${effMap}`}>full opponent report →</Link>
            </p>
          )}
        </div>
      )}
    </>
  );
}
