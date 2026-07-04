import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { buildLocalReport, localTeams, type LocalReport } from '../lib/localreport';

// Lokal takım raporu: kullanıcının kendi arşivinden, tamamen tarayıcıda.
export default function LocalReportPage() {
  const [params, setParams] = useSearchParams();
  const team = params.get('team') ?? '';
  const map = params.get('map') ?? '';

  const teams = useQuery({ queryKey: ['localTeams'], queryFn: localTeams });
  const [rep, setRep] = useState<LocalReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!team || !map) { setRep(null); return; }
    setBusy(true);
    buildLocalReport(team, map).then((r) => { setRep(r); setBusy(false); });
  }, [team, map]);

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    p.set(k, v);
    if (k === 'team') p.delete('map');
    setParams(p, { replace: true });
  };
  const teamInfo = teams.data?.find((t) => t.name === team);

  return (
    <>
      <h1>Your team report <span className="meta">— computed locally, nothing leaves your browser</span></h1>
      <div className="toolbar">
        <select value={team} onChange={(e) => set('team', e.target.value)}>
          <option value="">team…</option>
          {(teams.data ?? []).map((t) => (
            <option key={t.name} value={t.name}>{t.name} ({t.matches})</option>
          ))}
        </select>
        {teamInfo && (
          <select value={map} onChange={(e) => set('map', e.target.value)}>
            <option value="">map…</option>
            {teamInfo.maps.map((m) => <option key={m}>{m}</option>)}
          </select>
        )}
        <Link to="/mydb" className="meta">← my database</Link>
      </div>
      {busy && <p className="meta">crunching your archive…</p>}
      {rep && !busy && <Body d={rep} />}
      {!team && <p className="meta">Pick a team from your local matches.</p>}
    </>
  );
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

function Body({ d }: { d: LocalReport }) {
  const ov = d.overview;
  return (
    <>
      <h2>{d.team} on {d.map} <span className="meta">· {d.matches} matches</span></h2>
      <div className="grid cards statgrid">
        <Stat label="Record" v={`${ov.wins}–${d.matches - ov.wins}`} n={`${d.matches} matches`} />
        <Stat label="T round win" v={pct(ov.t_wins, ov.t_rounds)} n={`${ov.t_wins}/${ov.t_rounds}`} />
        <Stat label="CT round win" v={pct(ov.ct_wins, ov.ct_rounds)} n={`${ov.ct_wins}/${ov.ct_rounds}`} />
        <Stat label="Pistols" v={pct(ov.pistol_w, ov.pistol_n)} n={`${ov.pistol_w}/${ov.pistol_n}`} />
        <Stat label="Convert after pistol" v={pct(ov.conv_w, ov.conv_n)} n={`n=${ov.conv_n}`} />
      </div>

      <h2>Economy <span className="meta">(rounds 2-12 / 14-24)</span></h2>
      <div className="grid cards two">
        {(['T', 'CT'] as const).map((s) => (
          <div key={s} className="card">
            <div className="teams"><span><span className={`badge ${s}`}>{s}</span> buys</span></div>
            <table><tbody>
              {Object.entries(d.economy.buy[s] ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td>{v}</td></tr>
              ))}
            </tbody></table>
          </div>
        ))}
      </div>
      {Object.keys(d.economy.afterPistolLoss).length > 0 && (
        <p className="meta">
          after a lost pistol: {Object.entries(d.economy.afterPistolLoss)
            .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(' · ')}
        </p>
      )}

      {d.setups.length > 0 && (
        <>
          <h2>Default setups <span className="meta">(15 s, ≥3 rounds)</span></h2>
          <div className="card" style={{ maxWidth: 720 }}>
            {d.setups.slice(0, 8).map((s) => (
              <div key={s.side + s.pattern} style={{ lineHeight: 1.8 }}>
                <span className={`badge ${s.side}`}>{s.side}</span>{' '}
                {s.pattern} <span className="meta">— {Math.round(100 * s.share)}% (n={s.n})</span>
              </div>
            ))}
          </div>
        </>
      )}

      {d.utility.length > 0 && (
        <>
          <h2>Utility spots <span className="meta">(≥3 throws)</span></h2>
          <table style={{ maxWidth: 720 }}>
            <thead><tr><th /><th>type</th><th>spot</th><th>throws</th><th className="meta">avg time</th></tr></thead>
            <tbody>
              {d.utility.slice(0, 14).map((u, i) => (
                <tr key={i}>
                  <td><span className={`badge ${u.side}`}>{u.side}</span></td>
                  <td>{u.type}</td><td>{u.label}</td><td>×{u.count}</td>
                  <td className="meta">~{Math.round(u.t_avg)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Players</h2>
      <table style={{ maxWidth: 820 }}>
        <thead>
          <tr><th>player</th><th /><th>rounds</th><th>entry</th><th>openings</th><th>AWP</th><th>util/r</th><th>blind kills</th></tr>
        </thead>
        <tbody>
          {d.players.filter((p) => p.rounds >= 8).map((p) => (
            <tr key={p.nickname + p.side}>
              <td>{p.nickname}</td>
              <td><span className={`badge ${p.side}`}>{p.side}</span></td>
              <td>{p.rounds}</td>
              <td>{Math.round(100 * p.entry_share)}%</td>
              <td>{p.opening_k}W–{p.opening_d}L</td>
              <td>{Math.round(100 * p.awp_share)}%</td>
              <td>{p.util_pr.toFixed(1)}</td>
              <td>{p.blind_kills}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {d.trades.length > 0 && (
        <>
          <h2>Trade pairs</h2>
          <table style={{ maxWidth: 480 }}>
            <tbody>
              {d.trades.map((t, i) => (
                <tr key={i}><td>{t.trader}</td><td className="meta">avenges</td><td>{t.avenged}</td><td>×{t.n}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {d.thrown.length > 0 && (
        <>
          <h2>Thrown rounds <span className="meta">(peak ≥75% then lost)</span></h2>
          <table style={{ maxWidth: 560 }}>
            <tbody>
              {d.thrown.map((t, i) => (
                <tr key={i}>
                  <td>round {t.round}</td>
                  <td>{Math.round(100 * t.peak)}% peak</td>
                  <td><Link to={`/match/${t.match_id}?round=${t.round}`}>▶ watch</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="meta" style={{ marginTop: 16 }}>{d.note}</p>
    </>
  );
}

function Stat({ label, v, n }: { label: string; v: string; n: string }) {
  return (
    <div className="card">
      <div className="meta">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#b6e2b6' }}>{v}</div>
      <div className="meta">{n}</div>
    </div>
  );
}
