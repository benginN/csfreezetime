"""Takım eğilimleri (mimari.md §6.2): küme frekansları + Bayesçi büzülme.

p_takım(küme) = (n·f_takım + k·p_lig) / (n + k), k = SHRINK_K.
Az veriyle lig ortalamasına yakın, çok veriyle takıma özgü konuşur.
"""

from __future__ import annotations

SHRINK_K = 20


def run(pgconn) -> int:
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM team_tendencies")
        # (harita, taraf, takım, küme) gözlem sayıları — side-swap güvenli:
        # taraf takımı raunt satırındaki t/ct_team_id'den gelir
        cur.execute(
            """
            WITH obs AS (
                SELECT m.map_name, 'T' AS side, r.t_team_id AS team_id,
                       r.t_strategy_cluster AS cluster_id
                FROM rounds r JOIN matches m ON m.match_id = r.match_id
                WHERE r.t_strategy_cluster IS NOT NULL AND r.t_team_id IS NOT NULL
                UNION ALL
                SELECT m.map_name, 'CT', r.ct_team_id, r.ct_strategy_cluster
                FROM rounds r JOIN matches m ON m.match_id = r.match_id
                WHERE r.ct_strategy_cluster IS NOT NULL AND r.ct_team_id IS NOT NULL
            )
            SELECT map_name, side, team_id, cluster_id, count(*)
            FROM obs GROUP BY 1, 2, 3, 4
            """
        )
        rows = cur.fetchall()

    # lig dağılımı ve takım sayıları
    from collections import defaultdict

    league: dict[tuple, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    team: dict[tuple, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for map_name, side, team_id, cluster_id, n in rows:
        league[(map_name, side)][cluster_id] += n
        team[(map_name, side, team_id)][cluster_id] += n

    inserted = 0
    with pgconn.cursor() as cur:
        for (map_name, side, team_id), counts in team.items():
            lg = league[(map_name, side)]
            lg_total = sum(lg.values())
            n_team = sum(counts.values())
            for cluster_id in lg:  # takımın hiç oynamadığı kümeler de yazılır (0 gözlem)
                f_team = counts.get(cluster_id, 0) / n_team if n_team else 0.0
                p_lig = lg[cluster_id] / lg_total
                shrunk = (n_team * f_team + SHRINK_K * p_lig) / (n_team + SHRINK_K)
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
