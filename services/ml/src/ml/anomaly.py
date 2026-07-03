"""Anomali bayrakları (mimari.md §6.3, temel sürüm): oyuncu-maç metriklerinin
oyuncunun kendi geçmişine göre sağlam z-skoru. |z| > eşik → bayrak.

Metrikler: ADR (raunt başına hasar), traded-death oranı (ölümü trade edildi mi),
first-kill katılımı (açılış kill/death'lerinde bulunma oranı).
"""

from __future__ import annotations

import os
import statistics

Z_THRESHOLD = float(os.environ.get("ANOMALY_Z", "1.5"))
MIN_MATCHES = 3   # geçmişsiz oyuncu bayraklanmaz


def _metrics(pgconn) -> list[tuple]:
    """(player_id, match_id, metric, value) — maç başına oyuncu metrikleri."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            WITH per_match AS (
                SELECT s.player_id, s.match_id,
                       count(*)                          AS rounds_played,
                       sum(s.damage_dealt)::real         AS dmg,
                       sum(s.deaths)                     AS deaths
                FROM player_round_states s
                JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
                GROUP BY s.player_id, s.match_id
            ),
            traded AS (   -- oyuncunun ölümlerinden kaçı trade edildi
                SELECT k.victim_id AS player_id, k.match_id,
                       count(*) FILTER (WHERE t.kill_id IS NOT NULL)::real AS traded,
                       count(*)::real AS total
                FROM kills k
                LEFT JOIN kills t ON t.match_id = k.match_id
                    AND t.round_number = k.round_number
                    AND t.is_trade AND t.victim_id = k.attacker_id
                    AND t.tick > k.tick AND t.tick - k.tick <= 320
                WHERE k.victim_id IS NOT NULL
                GROUP BY k.victim_id, k.match_id
            ),
            fk AS (       -- açılış kill/death katılımı
                SELECT p.player_id, k.match_id,
                       count(*) FILTER (WHERE k.is_first_kill
                            AND (k.attacker_id = p.player_id OR k.victim_id = p.player_id))::real AS fk_inv
                FROM kills k
                CROSS JOIN LATERAL (VALUES (k.attacker_id), (k.victim_id)) AS p(player_id)
                WHERE p.player_id IS NOT NULL
                GROUP BY p.player_id, k.match_id
            )
            SELECT pm.player_id, pm.match_id,
                   pm.dmg / NULLIF(pm.rounds_played, 0)                 AS adr,
                   COALESCE(tr.traded / NULLIF(tr.total, 0), 0)          AS traded_death_rate,
                   COALESCE(f.fk_inv, 0) / NULLIF(pm.rounds_played, 0)   AS fk_involvement
            FROM per_match pm
            LEFT JOIN traded tr ON tr.player_id = pm.player_id AND tr.match_id = pm.match_id
            LEFT JOIN fk f ON f.player_id = pm.player_id AND f.match_id = pm.match_id
            """
        )
        out = []
        for pid, mid, adr, tdr, fki in cur.fetchall():
            for metric, val in (("adr", adr), ("traded_death_rate", tdr), ("fk_involvement", fki)):
                if val is not None:
                    out.append((pid, mid, metric, float(val)))
        return out


def run(pgconn) -> int:
    rows = _metrics(pgconn)
    by_player_metric: dict[tuple, list[tuple]] = {}
    for pid, mid, metric, val in rows:
        by_player_metric.setdefault((pid, metric), []).append((mid, val))

    flags = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM anomaly_flags")
        for (pid, metric), vals in by_player_metric.items():
            if len(vals) < MIN_MATCHES + 1:
                continue
            for mid, val in vals:
                baseline = [v for m, v in vals if m != mid]  # kendi maçı hariç
                mean = statistics.fmean(baseline)
                std = statistics.pstdev(baseline)
                if std < 1e-6:
                    continue
                z = (val - mean) / std
                if abs(z) > Z_THRESHOLD:
                    cur.execute(
                        """
                        INSERT INTO anomaly_flags
                            (player_id, match_id, metric, value, baseline_mean, baseline_std, z)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        (pid, mid, metric, val, mean, std, z),
                    )
                    flags += 1
    pgconn.commit()
    return flags
