import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isStatic, staticGet } from '../lib/staticdata';

// Arşiv geneli oyuncu sıralamaları — her tablo kendi örneklem kapısıyla.
interface LRow { nickname: string; player_id: string; team: string | null }
interface Boards {
  min_rounds: number;
  adr: (LRow & { adr: number; rounds: number })[];
  openings: (LRow & { won: number; lost: number; diff: number })[];
  clutch: (LRow & { wins: number; attempts: number; rate: number })[];
  flash: (LRow & { thrown: number; per_flash: number })[];
  trades: (LRow & { trades: number })[];
}

export default function Leaderboards() {
  const [d, setD] = useState<Boards | null>(null);
  useEffect(() => {
    (isStatic
      ? staticGet<Boards>('/api/v1/leaderboards')
      : fetch('/api/v1/leaderboards').then((r) => r.json())
    ).then(setD).catch(() => {});
  }, []);
  if (!d) return <p className="meta">loading…</p>;

  return (
    <>
      <h1>Leaderboards <span className="meta">— whole archive, sample gates per board</span></h1>
      <div className="grid cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        <Board title="ADR" note={`min ${d.min_rounds} rounds`}>
          {d.adr.map((r, i) => (
            <Row key={r.player_id} i={i} r={r} v={String(r.adr)} n={`${r.rounds}r`} />
          ))}
        </Board>
        <Board title="Opening duels" note="net (won − lost), min 15 duels">
          {d.openings.map((r, i) => (
            <Row key={r.player_id} i={i} r={r} v={`+${r.diff}`} n={`${r.won}W–${r.lost}L`} />
          ))}
        </Board>
        <Board title="Clutches" note="1vX wins, min 8 situations">
          {d.clutch.map((r, i) => (
            <Row key={r.player_id} i={i} r={r} v={`${r.wins}W`} n={`${r.rate}% of ${r.attempts}`} />
          ))}
        </Board>
        <Board title="Flash effectiveness" note="enemies blinded per flash, min 30 thrown">
          {d.flash.map((r, i) => (
            <Row key={r.player_id} i={i} r={r} v={r.per_flash.toFixed(2)} n={`${r.thrown} thrown`} />
          ))}
        </Board>
        <Board title="Trade kills" note="min 10 trades">
          {d.trades.map((r, i) => (
            <Row key={r.player_id} i={i} r={r} v={String(r.trades)} n="" />
          ))}
        </Board>
      </div>
    </>
  );
}

function Board({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="teams"><span>{title}</span><span className="meta">{note}</span></div>
      <table style={{ marginTop: 6 }}>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ i, r, v, n }: { i: number; r: LRow; v: string; n: string }) {
  return (
    <tr>
      <td className="meta" style={{ width: 22 }}>{i + 1}</td>
      <td><Link to={`/player/${r.player_id}`}>{r.nickname}</Link></td>
      <td className="meta cut">{r.team ?? ''}</td>
      <td style={{ fontWeight: 700, color: '#b6e2b6' }}>{v}</td>
      <td className="meta">{n}</td>
    </tr>
  );
}
