"""Utility istihbaratı: takımın standart smoke/molotof/flash noktaları.

Kümeleme: açgözlü yarıçap kümeleme — deterministik, k seçimi yok.
Noktalar kronolojik gezilir; mevcut bir merkezin R yarıçapına düşen nokta
o kümeye atanır (merkez koşan ortalamayla güncellenir), düşmeyen yeni küme
açar. n >= MIN_COUNT kümeler saklanır; adlandırma en yakın yerleşim merkezi.
"""

from __future__ import annotations

import json
import math
import statistics
from collections import Counter, defaultdict

from . import places

RADIUS = {"smoke": 48.0, "molotov": 48.0, "flash": 72.0, "he": 72.0}  # radar birimi
MIN_COUNT = 3
TYPES = tuple(RADIUS)


def _fetch(pgconn) -> list[tuple]:
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT m.map_name, g.side,
                   CASE WHEN g.side = 'T' THEN r.t_team_id ELSE r.ct_team_id END AS team_id,
                   g.type,
                   -- atış zamanı (sn, freeze-end'e göre); round_time_throw parser'da yok
                   (g.throw_tick - r.freeze_end_tick) / 64.0 AS t_throw,
                   g.det_x, g.det_y, g.throw_x, g.throw_y,
                   g.match_id::text, g.round_number,
                   CASE WHEN g.side = 'T' THEN r.t_strategy_cluster
                        ELSE r.ct_strategy_cluster END AS strat
            FROM grenades g
            JOIN rounds  r ON r.match_id = g.match_id AND r.round_number = g.round_number
            JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
            WHERE g.type = ANY(%s) AND g.det_x IS NOT NULL AND g.side IN ('T','CT')
              AND r.freeze_end_tick IS NOT NULL
            ORDER BY g.match_id, g.round_number, g.detonate_tick
            """,
            (list(TYPES),),
        )
        return cur.fetchall()


def run(pgconn, chc) -> int:
    rows = _fetch(pgconn)

    cals: dict[str, tuple[float, float, float]] = {}
    namers: dict[str, places.PlaceNamer] = {}

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for (map_name, side, team, gtype, t_throw, dx, dy, tx, ty, mid, rn, strat) in rows:
        if team is None:
            continue
        if map_name not in cals:
            cals[map_name] = places.radar_cal(pgconn, map_name)
        px, py, sc = cals[map_name]
        g = {
            "rx": (dx - px) / sc, "ry": (py - dy) / sc,
            "trx": (tx - px) / sc if tx is not None else None,
            "try": (py - ty) / sc if ty is not None else None,
            "t": t_throw, "mid": mid, "rn": rn, "strat": strat,
        }
        groups[(team, map_name, side, gtype)].append(g)

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM utility_spots")
        for (team, map_name, side, gtype), items in sorted(
            groups.items(), key=lambda kv: (str(kv[0][0]), kv[0][1], kv[0][2], kv[0][3])
        ):
            total = len(items)
            radius = RADIUS[gtype]
            clusters: list[dict] = []
            for it in items:
                best = None
                best_d = radius
                for c in clusters:
                    d = math.hypot(it["rx"] - c["rx"], it["ry"] - c["ry"])
                    if d < best_d:
                        best, best_d = c, d
                if best is None:
                    clusters.append({"rx": it["rx"], "ry": it["ry"], "members": [it]})
                else:
                    n = len(best["members"])
                    best["rx"] = (best["rx"] * n + it["rx"]) / (n + 1)
                    best["ry"] = (best["ry"] * n + it["ry"]) / (n + 1)
                    best["members"].append(it)

            keep = [c for c in clusters if len(c["members"]) >= MIN_COUNT]
            keep.sort(key=lambda c: -len(c["members"]))
            if not keep:
                continue
            if map_name not in namers:
                namers[map_name] = places.PlaceNamer(chc, pgconn, map_name)

            for cid, c in enumerate(keep):
                ms = c["members"]
                ts = [m["t"] for m in ms if m["t"] is not None]
                throws = [(m["trx"], m["try"]) for m in ms if m["trx"] is not None]
                strat_mix = Counter(m["strat"] for m in ms if m["strat"] is not None)
                cur.execute(
                    """
                    INSERT INTO utility_spots
                        (team_id, map_name, side, type, cluster_id, label,
                         det_rx, det_ry, throw_rx, throw_ry, count, share,
                         t_avg, t_std, strat_mix, representatives)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        team, map_name, side, gtype, cid,
                        namers[map_name].nearest(c["rx"], c["ry"]),
                        c["rx"], c["ry"],
                        (sum(t[0] for t in throws) / len(throws)) if throws else None,
                        (sum(t[1] for t in throws) / len(throws)) if throws else None,
                        len(ms), len(ms) / total,
                        statistics.mean(ts) if ts else None,
                        statistics.pstdev(ts) if len(ts) > 1 else None,
                        json.dumps({str(k): v for k, v in strat_mix.most_common(3)}),
                        json.dumps([
                            {"match_id": m["mid"], "round_number": m["rn"]} for m in ms[:3]
                        ]),
                    ),
                )
                inserted += 1
    pgconn.commit()
    return inserted
