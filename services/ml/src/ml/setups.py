"""Kurulum (default) tespiti: raunt başlangıcından t saniye sonra takımın
5 oyuncusunun yerleşim çoklu-kümesi. Desen anahtarı sıralı yer listesidir
("BDoors×2, Connector×1, ..."); frekanslar takım+harita+taraf başına sayılır.

avg_hold_sec: desen rauntlarında oyuncuların t anındaki yerinde ilk yer
değişimine kadar kalma medyanı — "default'u ne kadar tutuyorlar".
"""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict

OFFSETS = (15, 30)     # raunt başından saniye
MIN_ROUNDS = 8         # taraf başına bu kadar raunt yoksa desen yazılmaz
MIN_OBSERVED = 3
MIN_SHARE = 0.10
TOP_PATTERNS = 4
HOLD_HORIZON = 75      # saniye; bu ufka kadar yer değişimi aranır


def _round_teams(pgconn) -> dict[tuple[str, int, str], str]:
    """(match_id, round_number, side) → team_id ve harita eşlemesi."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT r.match_id::text, r.round_number, m.map_name,
                   r.t_team_id::text, r.ct_team_id::text
            FROM rounds r JOIN matches m ON m.match_id = r.match_id
            WHERE m.status = 'ready' AND r.t_team_id IS NOT NULL
            """
        )
        out = {}
        for mid, rn, map_name, t_team, ct_team in cur.fetchall():
            out[(mid, rn, "T")] = (map_name, t_team)
            out[(mid, rn, "CT")] = (map_name, ct_team)
        return out


def _positions_at(chc, map_name: str, sec: int) -> dict[tuple[str, int, str], list[str]]:
    """(match, round, side) → t=sec anındaki oyuncu yerleşimleri (mod)."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number, side, toString(player_id),
               place, count() AS c
        FROM player_ticks
        WHERE map_name = %(m)s AND is_alive AND place != ''
          AND round_time >= %(lo)s AND round_time < %(hi)s
        GROUP BY match_id, round_number, side, player_id, place
        """,
        parameters={"m": map_name, "lo": sec - 1, "hi": sec + 1},
    ).result_rows
    best: dict[tuple, tuple[int, str]] = {}
    for mid, rn, side, pid, place, c in rows:
        k = (mid, rn, side, pid)
        if k not in best or c > best[k][0]:
            best[k] = (c, place)
    out: dict[tuple, list[str]] = defaultdict(list)
    for (mid, rn, side, _pid), (_c, place) in best.items():
        out[(mid, rn, side)].append(place)
    return out


def _hold_seconds(chc, map_name: str, side: str, sec: int) -> dict[tuple[str, int, str], float]:
    """(match, round, player) → t=sec'teki yerde kalma süresi (1 Hz örnekleme)."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number, toString(player_id),
               toUInt16(floor(round_time)) AS sec_b, any(place) AS plc
        FROM player_ticks
        WHERE map_name = %(m)s AND side = %(side)s AND is_alive AND place != ''
          AND round_time >= %(lo)s AND round_time < %(hi)s
        GROUP BY match_id, round_number, player_id, sec_b
        ORDER BY match_id, round_number, player_id, sec_b
        """,
        parameters={"m": map_name, "side": side, "lo": sec, "hi": HOLD_HORIZON},
    ).result_rows
    seq: dict[tuple, list[tuple[int, str]]] = defaultdict(list)
    for mid, rn, pid, s, place in rows:
        seq[(mid, rn, pid)].append((s, place))
    holds = {}
    for k, sam in seq.items():
        base = sam[0][1]
        hold = float(HOLD_HORIZON - sec)
        for s, place in sam:
            if place != base:
                hold = float(s - sec)
                break
        holds[k] = hold
    return holds


def run(pgconn, chc) -> int:
    rteams = _round_teams(pgconn)
    maps = sorted({v[0] for v in rteams.values()})

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_setups")
        for map_name in maps:
            for off in OFFSETS:
                pos = _positions_at(chc, map_name, off)
                # (team, side) → [(pattern_key, mid, rn)]
                per_team: dict[tuple, list[tuple]] = defaultdict(list)
                for (mid, rn, side), plist in pos.items():
                    meta = rteams.get((mid, rn, side))
                    if not meta or meta[0] != map_name or len(plist) < 4:
                        continue
                    key = tuple(sorted(plist))
                    per_team[(meta[1], side)].append((key, mid, rn))

                hold_cache: dict[str, dict] = {}
                for (team, side), entries in sorted(per_team.items()):
                    n = len(entries)
                    if n < MIN_ROUNDS:
                        continue
                    freq = Counter(e[0] for e in entries)
                    top = [
                        (pat, c) for pat, c in freq.most_common(TOP_PATTERNS)
                        if c >= MIN_OBSERVED or c / n >= MIN_SHARE
                    ]
                    if side not in hold_cache:
                        hold_cache[side] = _hold_seconds(chc, map_name, side, off)
                    holds = hold_cache[side]
                    for pid_i, (pat, c) in enumerate(top):
                        rounds_in = [(mid, rn) for key, mid, rn in entries if key == pat]
                        hs = [
                            h for (mid, rn, _p), h in holds.items()
                            if (mid, rn) in set(rounds_in)
                        ]
                        pattern = [
                            {"place": p, "n": k}
                            for p, k in sorted(Counter(pat).items())
                        ]
                        cur.execute(
                            """
                            INSERT INTO team_setups
                                (team_id, map_name, side, t_offset, pattern_id,
                                 pattern, observed, sample_size, share,
                                 avg_hold_sec, representatives)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            """,
                            (
                                team, map_name, side, off, pid_i,
                                json.dumps(pattern), c, n, c / n,
                                statistics.median(hs) if hs else None,
                                json.dumps([
                                    {"match_id": mid, "round_number": rn}
                                    for mid, rn in rounds_in[:3]
                                ]),
                            ),
                        )
                        inserted += 1
    pgconn.commit()
    return inserted
