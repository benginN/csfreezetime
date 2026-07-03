"""Clutch tespiti (1vX): bir tarafta tam 1 canlı kalırken karşıda X≥1 varsa.

Raunt başına en fazla bir clutch kaydedilir (ilk oluşan; X o anın değeri).
Kazanım = yalnız oyuncunun tarafı raundu aldı mı. Tick verisinden
deterministik; oyuncu kimliği o saniyedeki tek canlıdan.
"""

from __future__ import annotations

from collections import defaultdict


def run(pgconn, chc) -> int:
    # raunt kazananları
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT r.match_id::text, r.round_number, r.winner_side
            FROM rounds r JOIN matches m ON m.match_id = r.match_id
            WHERE m.status = 'ready' AND r.winner_side IN ('T','CT')
            """
        )
        winners = {(mid, rn): w for mid, rn, w in cur.fetchall()}

    # saniye başına canlılar (kimlikli)
    rows = chc.query(
        """
        SELECT toString(match_id), round_number,
               toUInt16(floor(round_time)) AS sec, side,
               groupUniqArrayIf(toString(player_id), is_alive) AS alive
        FROM player_ticks
        WHERE round_time >= 0 AND round_time < 115
        GROUP BY match_id, round_number, sec, side
        ORDER BY match_id, round_number, sec
        """
    ).result_rows
    per_round: dict[tuple, dict[int, dict[str, list[str]]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for mid, rn, sec, side, alive in rows:
        per_round[(mid, rn)][sec][side] = list(alive)

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM clutches")
        for key, secs in per_round.items():
            w = winners.get(key)
            if not w:
                continue
            for sec in sorted(secs):
                sides = secs[sec]
                t = sides.get("T", [])
                ct = sides.get("CT", [])
                solo_side, solo, versus = None, None, 0
                if len(t) == 1 and len(ct) >= 1:
                    solo_side, solo, versus = "T", t[0], len(ct)
                elif len(ct) == 1 and len(t) >= 1:
                    solo_side, solo, versus = "CT", ct[0], len(t)
                if solo_side is None:
                    continue
                cur.execute(
                    """
                    INSERT INTO clutches
                        (match_id, round_number, player_id, side, versus, start_sec, won)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (key[0], key[1], solo, solo_side, versus, float(sec), w == solo_side),
                )
                inserted += 1
                break  # raunt başına ilk clutch
    pgconn.commit()
    return inserted
