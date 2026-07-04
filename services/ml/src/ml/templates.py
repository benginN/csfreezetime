"""Execute şablonu madenciliği (analitik #5).

Bir takımın T raundunda ilk 25 saniyede kullandığı utility, o takımın
bilinen utility noktalarına (utility_spots kümeleri) atanır; raunt böylece
"TopofMid smoke + A ramp molotov + short flash" gibi bir şablon anahtarına
indirgenir. Farklı maçlarda ≥3 kez tekrarlanan şablonlar, gittikleri site
ve kazanma oranıyla birlikte team_exec_templates'a yazılır.

Tamamen deterministik: en yakın merkez ataması (tip başına yarıçap
utility.py ile aynı), sıralı anahtar, sabit eşikler. Her şablon n taşır.
"""

from __future__ import annotations

import json
from collections import defaultdict

from .utility import RADIUS

WINDOW_SEC = 25.0  # rauntun ilk N saniyesi (execute penceresi)
MIN_N = 3          # şablon en az bu kadar tekrarlanmalı
MIN_NADES = 2      # tek bombalık "şablon" sayılmaz


def run(pgconn) -> int:
    with pgconn.cursor() as cur:
        # takımın utility nokta merkezleri (T tarafı)
        cur.execute(
            """
            SELECT team_id, map_name, type, cluster_id, label, det_rx, det_ry
            FROM utility_spots WHERE side = 'T'
            """
        )
        spots = defaultdict(list)  # (team,map,type) -> [(cid,label,rx,ry)]
        for team, mp, typ, cid, label, rx, ry in cur.fetchall():
            spots[(team, mp, typ)].append((cid, label or f"{typ}#{cid}", rx, ry))

        # T rauntları + kazanım + site
        cur.execute(
            """
            SELECT r.match_id, r.round_number, r.t_team_id, m.map_name,
                   (r.winner_side = 'T') AS won, r.bomb_site
            FROM rounds r JOIN matches m ON m.match_id = r.match_id
            WHERE m.status = 'ready' AND r.t_team_id IS NOT NULL
              AND r.winner_side IS NOT NULL
            """
        )
        rounds = cur.fetchall()
        rkey = {(mid, rn): (team, mp, won, site) for mid, rn, team, mp, won, site in rounds}

        # ilk 25 sn T bombaları (radar uzayında)
        cur.execute(
            """
            SELECT g.match_id, g.round_number, g.type,
                   (g.det_x - mp.radar_pos_x) / mp.radar_scale AS rx,
                   (mp.radar_pos_y - g.det_y) / mp.radar_scale AS ry
            FROM grenades g
            JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
            JOIN maps mp ON mp.map_name = m.map_name
            JOIN rounds r ON (r.match_id, r.round_number)
                 = (g.match_id, g.round_number)
            WHERE g.side = 'T' AND g.type <> 'decoy'
              AND g.det_x IS NOT NULL
              AND g.throw_tick IS NOT NULL AND r.freeze_end_tick IS NOT NULL
              AND (g.throw_tick - r.freeze_end_tick) <= %s * 64
            """,
            (WINDOW_SEC,),
        )
        per_round = defaultdict(list)  # (mid,rn) -> [label,...]
        for mid, rn, typ, rx, ry in cur.fetchall():
            info = rkey.get((mid, rn))
            if not info:
                continue
            team, mp, _, _ = info
            best, bd = None, RADIUS.get(typ, 60.0) ** 2
            for cid, label, cx, cy in spots.get((team, mp, typ), ()):
                d = (rx - cx) ** 2 + (ry - cy) ** 2
                if d < bd:
                    bd, best = d, f"{label} {typ}"
            if best:
                per_round[(mid, rn)].append(best)

    # şablon sayımı
    agg = defaultdict(lambda: [0, 0, defaultdict(int)])  # (team,map,key) -> [n,wins,sites]
    for (mid, rn), labels in per_round.items():
        if len(labels) < MIN_NADES:
            continue
        team, mp, won, site = rkey[(mid, rn)]
        key = tuple(sorted(set(labels)))
        if len(key) < MIN_NADES:
            continue
        a = agg[(team, mp, key)]
        a[0] += 1
        a[1] += 1 if won else 0
        a[2][site or "no plant"] += 1

    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_exec_templates")
        n_written = 0
        for (team, mp, key), (n, wins, sites) in agg.items():
            if n < MIN_N:
                continue
            cur.execute(
                """
                INSERT INTO team_exec_templates
                    (team_id, map_name, pattern, n, wins, site_mix)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (team, mp, json.dumps(list(key)), n, wins,
                 json.dumps(dict(sites))),
            )
            n_written += 1
    pgconn.commit()
    return n_written
