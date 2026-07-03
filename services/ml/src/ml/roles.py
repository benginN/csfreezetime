"""Rol çıkarımı: pozisyon + zamanlama + envanter verisinden oyuncu profilleri.

Tamamı deterministik metrik + açık eşikler; her etiket kanıtla birlikte
sunulur, MIN_ROUNDS altında etiket verilmez (yalnız ham metrikler yazılır).
"""

from __future__ import annotations

import statistics
from collections import defaultdict

MIN_ROUNDS = 30          # etiket için taraf başına raunt eşiği
ENTRY_SHARE = 0.28       # takımın ilk düellosuna girme payı
ANCHOR_SHARE = 0.50      # tek yerleşim işgal payı (CT)
AWP_SHARE = 0.40         # envanterde AWP olan raunt payı
LURK_FACTOR = 1.5        # taraf medyanının katı


def _rounds_played(pgconn) -> dict[tuple[str, str], dict]:
    """(player_id, side) → {rounds, dmg, fa, team_id}"""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT s.player_id::text, s.side, count(*),
                   COALESCE(sum(s.damage_dealt), 0),
                   COALESCE(sum(s.flash_assists), 0),
                   max(p.current_team_id::text)
            FROM player_round_states s
            JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
            JOIN players p ON p.player_id = s.player_id
            GROUP BY s.player_id, s.side
            """
        )
        return {
            (pid, side): {"rounds": n, "dmg": dmg, "fa": fa, "team": team}
            for pid, side, n, dmg, fa, team in cur.fetchall()
        }


def _openings(pgconn) -> dict[tuple[str, str], dict]:
    """İlk düellolar: (player, side) → {ok, od} (kills.is_first_kill)."""
    out: dict[tuple, dict] = defaultdict(lambda: {"ok": 0, "od": 0})
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT k.attacker_id::text, sa.side, k.victim_id::text, sv.side
            FROM kills k
            JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
            LEFT JOIN player_round_states sa
              ON (sa.match_id, sa.round_number, sa.player_id) =
                 (k.match_id, k.round_number, k.attacker_id)
            LEFT JOIN player_round_states sv
              ON (sv.match_id, sv.round_number, sv.player_id) =
                 (k.match_id, k.round_number, k.victim_id)
            WHERE k.is_first_kill
            """
        )
        for a, aside, v, vside in cur.fetchall():
            if a and aside:
                out[(a, aside)]["ok"] += 1
            if v and vside:
                out[(v, vside)]["od"] += 1
    return out


def _util(pgconn) -> dict[tuple[str, str], int]:
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT g.thrower_id::text, g.side, count(*)
            FROM grenades g JOIN matches m ON m.match_id = g.match_id AND m.status='ready'
            WHERE g.thrower_id IS NOT NULL AND g.side IN ('T','CT')
            GROUP BY g.thrower_id, g.side
            """
        )
        return {(pid, side): n for pid, side, n in cur.fetchall()}


def _awp_share(chc) -> dict[tuple[str, str], float]:
    rows = chc.query(
        """
        SELECT toString(player_id), side,
               countDistinctIf((match_id, round_number), has(inventory, 'AWP')) AS awp_r,
               countDistinct((match_id, round_number)) AS total_r
        FROM player_ticks WHERE is_alive
        GROUP BY player_id, side
        """
    ).result_rows
    return {(pid, side): (awp / total if total else 0.0) for pid, side, awp, total in rows}


def _lurk(chc) -> dict[tuple[str, str], float]:
    """İlk 30 sn'de takım merkezine ortalama uzaklık (radar değil, world unit)."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number, side,
               toUInt16(floor(round_time)) AS s,
               toString(player_id), any(x), any(y)
        FROM player_ticks
        WHERE is_alive AND round_time >= 0 AND round_time < 30
        GROUP BY match_id, round_number, side, s, player_id
        """
    ).result_rows
    bucket: dict[tuple, list[tuple[str, float, float]]] = defaultdict(list)
    for mid, rn, side, s, pid, x, y in rows:
        bucket[(mid, rn, side, s)].append((pid, x, y))
    acc: dict[tuple, list[float]] = defaultdict(list)
    for (_mid, _rn, side, _s), plist in bucket.items():
        if len(plist) < 3:
            continue
        cx = sum(p[1] for p in plist) / len(plist)
        cy = sum(p[2] for p in plist) / len(plist)
        for pid, x, y in plist:
            acc[(pid, side)].append(((x - cx) ** 2 + (y - cy) ** 2) ** 0.5)
    return {k: sum(v) / len(v) for k, v in acc.items() if v}


def _anchor(chc) -> dict[tuple[str, str], tuple[str, float, str]]:
    """(player, side) → (yer, işgal payı, harita) — en çok oynadığı haritada."""
    rows = chc.query(
        """
        SELECT toString(player_id), side, map_name, place, count() AS c
        FROM player_ticks
        WHERE is_alive AND place != '' AND round_time > 15  -- spawn/freeze sayılmaz
        GROUP BY player_id, side, map_name, place
        """
    ).result_rows
    per_map: dict[tuple, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for pid, side, map_name, place, c in rows:
        per_map[(pid, side, map_name)][place] += c
    # oyuncu+taraf başına en çok tick'li harita
    best_map: dict[tuple, tuple[int, str]] = {}
    for (pid, side, map_name), places in per_map.items():
        tot = sum(places.values())
        k = (pid, side)
        if k not in best_map or tot > best_map[k][0]:
            best_map[k] = (tot, map_name)
    out = {}
    for (pid, side), (tot, map_name) in best_map.items():
        places = per_map[(pid, side, map_name)]
        top_place, top_c = max(places.items(), key=lambda kv: kv[1])
        out[(pid, side)] = (top_place, top_c / tot, map_name)
    return out


def run(pgconn, chc) -> int:
    base = _rounds_played(pgconn)
    opens = _openings(pgconn)
    util = _util(pgconn)
    awp = _awp_share(chc)
    lurk = _lurk(chc)
    anchor = _anchor(chc)

    # Lurk eşiği: taraf başına medyan (yeterli raunta sahip oyuncular)
    lurk_median: dict[str, float] = {}
    for side in ("T", "CT"):
        vals = [
            v for (pid, s), v in lurk.items()
            if s == side and base.get((pid, s), {}).get("rounds", 0) >= MIN_ROUNDS
        ]
        lurk_median[side] = statistics.median(vals) if vals else 0.0

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM player_roles")
        for (pid, side), b in sorted(base.items()):
            n = b["rounds"]
            o = opens.get((pid, side), {"ok": 0, "od": 0})
            attempts = o["ok"] + o["od"]
            entry_share = attempts / n if n else None
            entry_success = o["ok"] / attempts if attempts else None
            lk = lurk.get((pid, side))
            an = anchor.get((pid, side))
            aw = awp.get((pid, side), 0.0)
            upr = util.get((pid, side), 0) / n if n else None
            fapr = b["fa"] / n if n else None
            adr = b["dmg"] / n if n else None

            tags: list[str] = []
            if n >= MIN_ROUNDS:
                if side == "T" and entry_share is not None and entry_share > ENTRY_SHARE:
                    tags.append("ENTRY")
                if (side == "T" and lk is not None and lurk_median["T"] > 0
                        and lk > lurk_median["T"] * LURK_FACTOR):
                    tags.append("LURKER")
                if side == "CT" and an is not None and an[1] > ANCHOR_SHARE:
                    tags.append(f"ANCHOR:{an[0]}")
                if aw > AWP_SHARE:
                    tags.append("AWP")

            cur.execute(
                """
                INSERT INTO player_roles
                    (player_id, team_id, side, rounds, entry_attempt_share,
                     entry_success, opening_kills, opening_deaths, lurk_dist_avg,
                     anchor_place, anchor_share, awp_round_share, util_per_round,
                     flash_assists_pr, adr, tags)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    pid, b["team"], side, n, entry_share, entry_success,
                    o["ok"], o["od"], lk,
                    an[0] if an else None, an[1] if an else None,
                    aw, upr, fapr, adr, tags,
                ),
            )
            inserted += 1
    pgconn.commit()
    return inserted
