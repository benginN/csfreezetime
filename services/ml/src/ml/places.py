"""Harita yerleşim merkezleri: kümeleri insan diliyle adlandırmak için.

maplayout.go'daki mantığın Python eşleniği — bölge adları oyuncu
pozisyonlarındaki `place` alanından gelir, merkez = ortalama radar konumu.
"""

from __future__ import annotations

import math

MIN_TICKS = 2000  # gürültü bölgeleri elenir (maplayout ile aynı eşik)


def radar_cal(pgconn, map_name: str) -> tuple[float, float, float]:
    with pgconn.cursor() as cur:
        cur.execute(
            "SELECT radar_pos_x, radar_pos_y, radar_scale FROM maps WHERE map_name = %s",
            (map_name,),
        )
        row = cur.fetchone()
    if not row:
        raise ValueError(f"radar kalibrasyonu yok: {map_name}")
    return float(row[0]), float(row[1]), float(row[2])


def centroids(chc, pgconn, map_name: str) -> list[tuple[str, float, float]]:
    """[(place, rx, ry)] — radar uzayında bölge merkezleri."""
    pos_x, pos_y, scale = radar_cal(pgconn, map_name)
    rows = chc.query(
        """
        SELECT place,
               avg((x - %(px)s) / %(sc)s)  AS rx,
               avg((%(py)s - y) / %(sc)s)  AS ry,
               count() AS c
        FROM player_ticks
        WHERE map_name = %(m)s AND place != '' AND is_alive
        GROUP BY place HAVING c > %(minc)s
        """,
        parameters={"m": map_name, "px": pos_x, "py": pos_y, "sc": scale, "minc": MIN_TICKS},
    ).result_rows
    return [(r[0], float(r[1]), float(r[2])) for r in rows]


class PlaceNamer:
    def __init__(self, chc, pgconn, map_name: str):
        self.points = centroids(chc, pgconn, map_name)

    def nearest(self, rx: float, ry: float) -> str | None:
        best, best_d = None, float("inf")
        for name, px, py in self.points:
            d = math.hypot(rx - px, ry - py)
            if d < best_d:
                best, best_d = name, d
        return best
