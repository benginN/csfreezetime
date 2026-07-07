"""Boost tespiti: raunt başında üst üste çıkan oyuncu çiftleri.

Geometri: aynı takımdan iki oyuncu, xy-düzleminde ≤55 birim yakın ve
z-farkı 40-110 birim (çömelme boyu ~46, ayakta ~64) ise boost'tur.
Gürültüye karşı aynı çift en az 2 farklı saniyede bu koşulu sağlamalı.
Raunt başına (taraf, bölge) bir kez sayılır; bölge = ÜSTTEKİ oyuncunun
place'i (boost'un amacı üsttekinin gördüğü açıdır).

Çıktı: team_boosts (takım, harita, taraf, bölge, n, temsilciler) —
raporda "Boost B from Monster ×7" satırları, ≥3 tekrar eşiğiyle (§10).
"""

from __future__ import annotations

import json
from collections import defaultdict

MIN_COUNT = 3        # rapor eşiği
XY_NEAR = 55.0       # yatay yakınlık (world unit)
DZ_MIN, DZ_MAX = 40.0, 110.0
MIN_SECS = 2         # aynı çift en az bu kadar saniye


def run(pgconn, chc) -> int:
    # raunt → takım eşlemesi (side'a göre)
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT r.match_id::text, r.round_number, r.t_team_id::text, r.ct_team_id::text
            FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
            WHERE r.t_team_id IS NOT NULL AND r.ct_team_id IS NOT NULL
            """
        )
        teams = {(mid, rn): {"T": t, "CT": ct} for mid, rn, t, ct in cur.fetchall()}

    rows = chc.query(
        """
        SELECT toString(match_id), map_name, round_number, side,
               toUInt16(floor(round_time)) AS sec,
               toString(player_id), any(x), any(y), any(z), any(place)
        FROM player_ticks
        WHERE is_alive AND round_time >= 5 AND round_time <= 30
        GROUP BY match_id, map_name, round_number, side, sec, player_id
        """
    ).result_rows

    bucket: dict[tuple, list] = defaultdict(list)
    for mid, mp, rn, side, sec, pid, x, y, z, place in rows:
        bucket[(mid, mp, rn, side, sec)].append((pid, x, y, z, place))

    # (mid, rn, side, çift) → {saniye sayısı, üst oyuncunun place'i}
    pair_secs: dict[tuple, dict] = defaultdict(lambda: {"secs": 0, "place": ""})
    for (mid, mp, rn, side, _sec), plist in bucket.items():
        for i in range(len(plist)):
            for j in range(i + 1, len(plist)):
                a, b = plist[i], plist[j]
                dz = a[3] - b[3]
                if abs(dz) < DZ_MIN or abs(dz) > DZ_MAX:
                    continue
                if (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > XY_NEAR ** 2:
                    continue
                upper = a if dz > 0 else b
                key = (mid, mp, rn, side, tuple(sorted((a[0], b[0]))))
                pair_secs[key]["secs"] += 1
                if upper[4]:
                    pair_secs[key]["place"] = upper[4]

    # raunt+taraf+bölge bir kez; takım kimliğine bağla
    agg: dict[tuple, dict] = defaultdict(lambda: {"rounds": set(), "reps": []})
    for (mid, mp, rn, side, _pair), info in pair_secs.items():
        if info["secs"] < MIN_SECS or not info["place"]:
            continue
        if "spawn" in info["place"].lower():
            continue  # spawn boost'u bilgi taşımaz
        team = teams.get((mid, rn), {}).get(side)
        if not team:
            continue
        k = (team, mp, side, info["place"])
        rkey = (mid, rn)
        if rkey not in agg[k]["rounds"]:
            agg[k]["rounds"].add(rkey)
            if len(agg[k]["reps"]) < 3:
                agg[k]["reps"].append({"match_id": mid, "round_number": rn})

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_boosts")
        for (team, mp, side, place), v in agg.items():
            n = len(v["rounds"])
            if n < MIN_COUNT:
                continue
            cur.execute(
                """
                INSERT INTO team_boosts
                    (team_id, map_name, side, place, n, representatives)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (team, mp, side, place, n, json.dumps(v["reps"])),
            )
            inserted += 1
    pgconn.commit()
    return inserted
