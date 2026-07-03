"""Zamansal değerlendirme (§6.2): tahmin yöntemleri taban çizgiyle yarışır.

Bölünme: her maçın son %25 rauntu test, kalanı eğitim (geleceğe sızıntı yok —
eğitim dağılımları yalnızca eğitim rauntlarından). Metrik: log-loss.
Kazanan yöntem prediction_meta'ya yazılır; API sunumunu oradan seçer —
taban çizgiyi geçemeyen yöntem sunulmaz (dokümanın ürün etiği ilkesi).
"""

from __future__ import annotations

import math
from collections import defaultdict

from . import predict

EPS = 1e-9
METHODS = ("league", "team", "team_buy")


def _fetch_rounds(pgconn) -> list[tuple]:
    """(map, side, team, buy, cluster, match_id, round_number) — sıralı."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT m.map_name, s.side, s.team_id, s.buy_type, s.cluster_id,
                   r.match_id::text, r.round_number
            FROM rounds r
            JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
            CROSS JOIN LATERAL (VALUES
                ('T',  r.t_team_id,  r.t_buy_type,  r.t_strategy_cluster),
                ('CT', r.ct_team_id, r.ct_buy_type, r.ct_strategy_cluster)
            ) AS s(side, team_id, buy_type, cluster_id)
            WHERE s.cluster_id IS NOT NULL AND s.team_id IS NOT NULL
            ORDER BY r.match_id, r.round_number
            """
        )
        return cur.fetchall()


def _split(rows: list[tuple]) -> tuple[list, list]:
    """Maç bazında zamansal bölünme: her maçın son %25 rauntu test."""
    by_match: dict[str, list] = defaultdict(list)
    for r in rows:
        by_match[r[5]].append(r)
    train, test = [], []
    for match_rows in by_match.values():
        match_rows.sort(key=lambda r: r[6])
        cut = max(1, int(len(match_rows) * 0.75))
        train.extend(match_rows[:cut])
        test.extend(match_rows[cut:])
    return train, test


def _logloss(train: list, test: list, method: str) -> float:
    tr = [(r[0], r[1], r[2], r[3], r[4]) for r in train]
    total, n = 0.0, 0
    for map_name, side, team, buy, cluster, *_ in test:
        if method == "league":
            dist = predict.league_dist(tr, map_name, side)
        elif method == "team":
            dist = predict.team_dist(tr, map_name, side, team)
        else:  # team_buy
            if buy is None:
                dist = predict.team_dist(tr, map_name, side, team)
            else:
                dist = predict.team_buy_dist(tr, map_name, side, team, buy)
        p = dist.get(cluster, 0.0)
        total += -math.log(max(p, EPS))
        n += 1
    return total / n if n else float("inf")


def run(pgconn) -> list[dict]:
    rows = _fetch_rounds(pgconn)
    train, test = _split(rows)

    # (harita, taraf) başına değerlendirme
    pairs = sorted({(r[0], r[1]) for r in test})
    results = []
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM prediction_meta")
        for map_name, side in pairs:
            te = [r for r in test if r[0] == map_name and r[1] == side]
            losses = {m: _logloss(train, te, m) for m in METHODS}
            # en iyi: log-loss en düşük; eşitlikte basit olan kazanır
            best = min(METHODS, key=lambda m: losses[m])
            results.append({"map": map_name, "side": side, "best": best,
                            "n_test": len(te), **losses})
            cur.execute(
                """
                INSERT INTO prediction_meta
                    (map_name, side, best_method, logloss_league, logloss_team,
                     logloss_team_buy, test_rounds)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (map_name, side, best, losses["league"], losses["team"],
                 losses["team_buy"], len(te)),
            )
    pgconn.commit()
    return results


def write_conditional(pgconn) -> int:
    """team_tendencies_cond: TÜM veriden (sunum tablosu; değerlendirme ayrı)."""
    rows = [(r[0], r[1], r[2], r[3], r[4]) for r in _fetch_rounds(pgconn)]
    combos = predict.counts_by_team_buy(rows)
    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_tendencies_cond")
        for (team, map_name, side, buy), counts in combos.items():
            dist = predict.team_buy_dist(rows, map_name, side, team, buy)
            n = sum(counts.values())
            for cluster, p in dist.items():
                cur.execute(
                    """
                    INSERT INTO team_tendencies_cond
                        (team_id, map_name, side, buy_type, cluster_id,
                         observed, sample_size, prob)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (team, map_name, side, buy, cluster,
                     counts.get(cluster, 0), n, p),
                )
                inserted += 1
    pgconn.commit()
    return inserted
