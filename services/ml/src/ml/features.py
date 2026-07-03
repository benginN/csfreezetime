"""Raunt "yaklaşım imzası" öznitelikleri (mimari.md §6.2 Aşama 1).

Her (maç, raunt, taraf) için: ilk 30 saniyede 5'er saniyelik 6 pencerede
bölge doluluk oranları + ilk 30 sn utility sayıları. Tamamen deterministik.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

WINDOWS = 6          # 6 × 5 sn = ilk 30 sn
WINDOW_SEC = 5
MAX_PLACES = 16      # harita başına en yoğun N bölge
UTIL_TYPES = ["smoke", "flash", "molotov", "he"]


@dataclass
class FeatureSet:
    map_name: str
    side: str
    places: list[str]                 # kolon sırası
    keys: list[tuple[str, int]]       # (match_id, round_number)
    X: np.ndarray                     # (n_rounds, WINDOWS*P + len(UTIL_TYPES))


def extract(ch, pgconn, map_name: str, side: str) -> FeatureSet | None:
    # Haritanın en yoğun bölgeleri (kolon uzayı sabitlenir)
    place_rows = ch.query(
        """
        SELECT place, count() AS c FROM player_ticks
        WHERE map_name = %(m)s AND place != '' AND is_alive
        GROUP BY place ORDER BY c DESC LIMIT %(lim)s
        """,
        parameters={"m": map_name, "lim": MAX_PLACES},
    ).result_rows
    places = [r[0] for r in place_rows]
    if len(places) < 4:
        return None
    place_idx = {p: i for i, p in enumerate(places)}

    # Pencere bazında bölge doluluğu
    occ = ch.query(
        """
        SELECT toString(match_id) AS mid, round_number,
               toUInt8(intDiv(toUInt16(floor(round_time)), %(ws)s)) AS win,
               place, count() AS c
        FROM player_ticks
        WHERE map_name = %(m)s AND side = %(s)s AND is_alive
          AND round_time >= 0 AND round_time < %(total)s AND place != ''
        GROUP BY mid, round_number, win, place
        """,
        parameters={"m": map_name, "s": side, "ws": WINDOW_SEC, "total": WINDOWS * WINDOW_SEC},
    ).result_rows

    # Utility: ilk 30 sn'de atılanlar (PG)
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT g.match_id::text, g.round_number, g.type, count(*)
            FROM grenades g
            JOIN rounds r ON r.match_id = g.match_id AND r.round_number = g.round_number
            JOIN matches m ON m.match_id = g.match_id
            WHERE m.map_name = %s AND g.side = %s AND m.status = 'ready'
              AND g.detonate_tick - r.freeze_end_tick < %s
            GROUP BY 1, 2, 3
            """,
            (map_name, side, WINDOWS * WINDOW_SEC * 64),
        )
        util_rows = cur.fetchall()

    keys = sorted({(r[0], int(r[1])) for r in occ})
    if not keys:
        return None
    key_idx = {k: i for i, k in enumerate(keys)}
    P = len(places)

    occ_m = np.zeros((len(keys), WINDOWS, P), dtype=np.float64)
    totals = np.zeros((len(keys), WINDOWS), dtype=np.float64)
    for mid, rn, win, place, c in occ:
        k = key_idx[(mid, int(rn))]
        w = int(win)
        if w >= WINDOWS:
            continue
        totals[k, w] += c
        if place in place_idx:
            occ_m[k, w, place_idx[place]] += c
    totals[totals == 0] = 1.0
    occ_m /= totals[:, :, None]      # pencere içi oran (0-1)

    util_m = np.zeros((len(keys), len(UTIL_TYPES)), dtype=np.float64)
    ut_idx = {t: i for i, t in enumerate(UTIL_TYPES)}
    for mid, rn, typ, c in util_rows:
        k = key_idx.get((mid, int(rn)))
        if k is not None and typ in ut_idx:
            util_m[k, ut_idx[typ]] = min(float(c), 5.0) / 5.0   # 0-1 ölçek

    X = np.concatenate([occ_m.reshape(len(keys), -1), util_m], axis=1)
    return FeatureSet(map_name=map_name, side=side, places=places, keys=keys, X=X)
