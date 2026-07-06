"""Takım eğilimleri (mimari.md §6.2): küme frekansları + Bayesçi büzülme.

p_takım(küme) = (n·f_takım + k·p_lig) / (n + k), k = SHRINK_K.
Az veriyle lig ortalamasına yakın, çok veriyle takıma özgü konuşur.

Zaman ağırlığı (recency.py): f_takım/p_lig son maçlara ağırlıklı hesaplanır
(90 gün yarı ömür); observed/sample_size ise ham (ağırlıksız) raunt sayısı
olarak kalır — eşik/şeffaflık bunlara bakar, yalnız olasılık ağırlıklıdır.
"""

from __future__ import annotations

from collections import defaultdict

from . import recency

SHRINK_K = 20


def run(pgconn) -> int:
    ref = recency.reference_date(pgconn)
    with pgconn.cursor() as cur:
        # (harita, taraf, takım, küme) gözlemleri — side-swap güvenli:
        # taraf takımı raunt satırındaki t/ct_team_id'den gelir
        cur.execute(
            """
            WITH obs AS (
                SELECT m.map_name, 'T' AS side, r.t_team_id AS team_id,
                       r.t_strategy_cluster AS cluster_id, m.played_at
                FROM rounds r JOIN matches m ON m.match_id = r.match_id
                WHERE r.t_strategy_cluster IS NOT NULL AND r.t_team_id IS NOT NULL
                UNION ALL
                SELECT m.map_name, 'CT', r.ct_team_id, r.ct_strategy_cluster, m.played_at
                FROM rounds r JOIN matches m ON m.match_id = r.match_id
                WHERE r.ct_strategy_cluster IS NOT NULL AND r.ct_team_id IS NOT NULL
            )
            SELECT map_name, side, team_id, cluster_id, played_at FROM obs
            """
        )
        rows = cur.fetchall()

    league_n: dict[tuple, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    league_w: dict[tuple, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    team_n: dict[tuple, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    team_w: dict[tuple, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    for map_name, side, team_id, cluster_id, played_at in rows:
        w = recency.weight(played_at, ref)
        league_n[(map_name, side)][cluster_id] += 1
        league_w[(map_name, side)][cluster_id] += w
        team_n[(map_name, side, team_id)][cluster_id] += 1
        team_w[(map_name, side, team_id)][cluster_id] += w

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_tendencies")
        for (map_name, side, team_id), counts in team_n.items():
            wcounts = team_w[(map_name, side, team_id)]
            lg_n = league_n[(map_name, side)]
            lg_w = league_w[(map_name, side)]
            lg_total_w = sum(lg_w.values())
            n_team = sum(counts.values())
            n_team_w = sum(wcounts.values())
            for cluster_id in lg_n:  # takımın hiç oynamadığı kümeler de yazılır (0 gözlem)
                f_team = wcounts.get(cluster_id, 0.0) / n_team_w if n_team_w else 0.0
                p_lig = lg_w.get(cluster_id, 0.0) / lg_total_w if lg_total_w else 0.0
                shrunk = (n_team_w * f_team + SHRINK_K * p_lig) / (n_team_w + SHRINK_K)
                cur.execute(
                    """
                    INSERT INTO team_tendencies
                        (team_id, map_name, side, cluster_id, observed, sample_size, shrunk_prob)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (team_id, map_name, side, cluster_id,
                     counts.get(cluster_id, 0), n_team, shrunk),
                )
                inserted += 1
    pgconn.commit()
    return inserted
