"""Zamansal değerlendirme (§6.2): tahmin yöntemleri taban çizgiyle yarışır.

Bölünme: her maçın son %25 rauntu test, kalanı eğitim (geleceğe sızıntı yok —
eğitim dağılımları yalnızca eğitim rauntlarından). Metrik: log-loss.
Kazanan yöntem prediction_meta'ya yazılır; API sunumunu oradan seçer —
taban çizgiyi geçemeyen yöntem sunulmaz (dokümanın ürün etiği ilkesi).
"""

from __future__ import annotations

import math
from collections import defaultdict

from . import predict, recency

EPS = 1e-9
METHODS = ("league", "team", "team_buy", "team_vs", "team_style")


def _fetch_rounds(pgconn) -> list[tuple]:
    """(map, side, team, buy, cluster, OPP, match_id, round_number, played_at) — sıralı."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT m.map_name, s.side, s.team_id, s.buy_type, s.cluster_id,
                   s.opp_id, r.match_id::text, r.round_number, m.played_at
            FROM rounds r
            JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
            CROSS JOIN LATERAL (VALUES
                ('T',  r.t_team_id,  r.t_buy_type,  r.t_strategy_cluster,  r.ct_team_id),
                ('CT', r.ct_team_id, r.ct_buy_type, r.ct_strategy_cluster, r.t_team_id)
            ) AS s(side, team_id, buy_type, cluster_id, opp_id)
            WHERE s.cluster_id IS NOT NULL AND s.team_id IS NOT NULL
            ORDER BY r.match_id, r.round_number
            """
        )
        return cur.fetchall()


def _split(rows: list[tuple]) -> tuple[list, list]:
    """Maç bazında zamansal bölünme: her maçın son %25 rauntu test."""
    by_match: dict[str, list] = defaultdict(list)
    for r in rows:
        by_match[r[6]].append(r)
    train, test = [], []
    for match_rows in by_match.values():
        match_rows.sort(key=lambda r: r[7])
        cut = max(1, int(len(match_rows) * 0.75))
        train.extend(match_rows[:cut])
        test.extend(match_rows[cut:])
    return train, test


def _logloss(train: list, test: list, method: str, ref) -> float:
    # rakip-farkındalı yöntemler için 6'lı satır (VsRow) + zaman ağırlığı
    tr = [(r[0], r[1], r[2], r[3], r[4], r[5], recency.weight(r[8], ref)) for r in train]
    # stil profilleri (map, side) başına bir kez — test grubu tek çift zaten
    prof_cache: dict[tuple, dict] = {}
    total, n = 0.0, 0
    for map_name, side, team, buy, cluster, opp, *_ in test:
        if method == "league":
            dist = predict.league_dist(tr, map_name, side)
        elif method == "team":
            dist = predict.team_dist(tr, map_name, side, team)
        elif method == "team_buy":
            if buy is None:
                dist = predict.team_dist(tr, map_name, side, team)
            else:
                dist = predict.team_buy_dist(tr, map_name, side, team, buy)
        elif method == "team_vs":
            dist = predict.team_vs_dist(tr, map_name, side, team, opp)
        else:  # team_style
            key = (map_name, side)
            if key not in prof_cache:
                prof_cache[key] = predict.opponent_profiles(tr, map_name, side)
            dist = predict.team_style_dist(tr, map_name, side, team, opp, prof_cache[key])
        p = dist.get(cluster, 0.0)
        total += -math.log(max(p, EPS))
        n += 1
    return total / n if n else float("inf")


def run(pgconn) -> list[dict]:
    rows = _fetch_rounds(pgconn)
    ref = recency.reference_date(pgconn)
    train, test = _split(rows)

    # (harita, taraf) başına değerlendirme
    pairs = sorted({(r[0], r[1]) for r in test})
    results = []
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM prediction_meta")
        for map_name, side in pairs:
            te = [r for r in test if r[0] == map_name and r[1] == side]
            losses = {m: _logloss(train, te, m, ref) for m in METHODS}
            # en iyi: log-loss en düşük; eşitlikte basit olan kazanır
            best = min(METHODS, key=lambda m: losses[m])
            results.append({"map": map_name, "side": side, "best": best,
                            "n_test": len(te), **losses})
            cur.execute(
                """
                INSERT INTO prediction_meta
                    (map_name, side, best_method, logloss_league, logloss_team,
                     logloss_team_buy, logloss_team_vs, logloss_team_style,
                     test_rounds)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (map_name, side, best, losses["league"], losses["team"],
                 losses["team_buy"], losses["team_vs"], losses["team_style"],
                 len(te)),
            )
    pgconn.commit()
    return results


def write_vs(pgconn) -> int:
    """team_tendencies_vs: rakip-kalibre sunum tablosu (TÜM veriden).

    İki yöntem tek tabloda ('vs' = head-to-head, 'style' = benzerlik havuzu).
    Sınır: takımın o harita+tarafta ≥12 rauntu olsun; 'vs' satırı için
    head-to-head ≥6 raunt (daha azı takım dağılımından ayırt edilemez),
    'style' satırı rakip profili olan her rakip için yazılır.
    """
    ref = recency.reference_date(pgconn)
    rows = [
        (r[0], r[1], r[2], r[3], r[4], r[5], recency.weight(r[8], ref))
        for r in _fetch_rounds(pgconn)
    ]
    by_ms: dict[tuple, list] = defaultdict(list)
    for r in rows:
        by_ms[(r[0], r[1])].append(r)

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_tendencies_vs")
        for (map_name, side), grp in by_ms.items():
            profs = predict.opponent_profiles(rows, map_name, side)
            # takım → raunt sayısı ve rakip → h2h sayısı
            n_team: dict = defaultdict(int)
            n_h2h: dict = defaultdict(int)
            for r in grp:
                n_team[r[2]] += 1
                if r[5] is not None:
                    n_h2h[(r[2], r[5])] += 1
            for team, nt in n_team.items():
                if nt < 12:
                    continue
                opps = {o for (t, o), n in n_h2h.items() if t == team and n >= 6}
                opps |= {o for o in profs if o != team}
                for opp in opps:
                    h2h = n_h2h.get((team, opp), 0)
                    for kind in ("vs", "style"):
                        if kind == "vs" and h2h < 6:
                            continue
                        dist = (predict.team_vs_dist(rows, map_name, side, team, opp)
                                if kind == "vs"
                                else predict.team_style_dist(rows, map_name, side, team, opp, profs))
                        for cluster, p in dist.items():
                            cur.execute(
                                """
                                INSERT INTO team_tendencies_vs
                                    (team_id, opp_team_id, map_name, side, kind,
                                     cluster_id, h2h_rounds, prob)
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                                """,
                                (team, opp, map_name, side, kind, cluster, h2h, p),
                            )
                            inserted += 1
    pgconn.commit()
    return inserted


def write_conditional(pgconn) -> int:
    """team_tendencies_cond: TÜM veriden (sunum tablosu; değerlendirme ayrı)."""
    ref = recency.reference_date(pgconn)
    rows = [
        (r[0], r[1], r[2], r[3], r[4], recency.weight(r[8], ref))
        for r in _fetch_rounds(pgconn)
    ]
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
