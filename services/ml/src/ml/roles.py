"""Rol çıkarımı: pozisyon + zamanlama + envanter verisinden oyuncu profilleri.

Tamamı deterministik metrik + açık eşikler; her etiket kanıtla birlikte
sunulur, MIN_ROUNDS altında etiket verilmez (yalnız ham metrikler yazılır).

Granülarite (2026-07-08): (oyuncu, taraf, harita) — "ANCHOR:BombsiteB"
hangi haritada sorusunun cevabı artık satırın kendisinde. map_name='' özel
satırı tüm-harita genel profildir (harita satırlarının toplamı); lurk
medyanı harita başına hesaplanır (harita geometrileri karşılaştırılamaz).
"""

from __future__ import annotations

import statistics
from collections import defaultdict

MIN_ROUNDS = 30          # etiket için (taraf, harita) başına raunt eşiği
ENTRY_SHARE = 0.28       # takımın ilk düellosuna girme payı
ANCHOR_SHARE = 0.50      # tek yerleşim işgal payı (CT)
AWP_SHARE = 0.40         # envanterde AWP olan raunt payı
LURK_FACTOR = 1.5        # taraf+harita medyanının katı

Key = tuple[str, str, str]  # (player_id, side, map_name)


def _rounds_played(pgconn) -> dict[Key, dict]:
    """(player, side, map) → {rounds, dmg, fa, team_id}"""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT s.player_id::text, s.side, m.map_name, count(*),
                   COALESCE(sum(s.damage_dealt), 0),
                   COALESCE(sum(s.flash_assists), 0),
                   max(p.current_team_id::text)
            FROM player_round_states s
            JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
                          AND m.map_name IS NOT NULL
            JOIN players p ON p.player_id = s.player_id
            GROUP BY s.player_id, s.side, m.map_name
            """
        )
        return {
            (pid, side, mp): {"rounds": n, "dmg": dmg, "fa": fa, "team": team}
            for pid, side, mp, n, dmg, fa, team in cur.fetchall()
        }


def _openings(pgconn) -> dict[Key, dict]:
    """İlk düellolar: (player, side, map) → {ok, od} (kills.is_first_kill)."""
    out: dict[Key, dict] = defaultdict(lambda: {"ok": 0, "od": 0})
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT k.attacker_id::text, sa.side, k.victim_id::text, sv.side, m.map_name
            FROM kills k
            JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
                          AND m.map_name IS NOT NULL
            LEFT JOIN player_round_states sa
              ON (sa.match_id, sa.round_number, sa.player_id) =
                 (k.match_id, k.round_number, k.attacker_id)
            LEFT JOIN player_round_states sv
              ON (sv.match_id, sv.round_number, sv.player_id) =
                 (k.match_id, k.round_number, k.victim_id)
            WHERE k.is_first_kill
            """
        )
        for a, aside, v, vside, mp in cur.fetchall():
            if a and aside:
                out[(a, aside, mp)]["ok"] += 1
            if v and vside:
                out[(v, vside, mp)]["od"] += 1
    return out


def _util(pgconn) -> dict[Key, int]:
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT g.thrower_id::text, g.side, m.map_name, count(*)
            FROM grenades g JOIN matches m ON m.match_id = g.match_id AND m.status='ready'
                                          AND m.map_name IS NOT NULL
            WHERE g.thrower_id IS NOT NULL AND g.side IN ('T','CT')
            GROUP BY g.thrower_id, g.side, m.map_name
            """
        )
        return {(pid, side, mp): n for pid, side, mp, n in cur.fetchall()}


def _awp_counts(chc) -> dict[Key, tuple[int, int]]:
    """(player, side, map) → (awp'li raunt, toplam raunt) — pay üstte türetilir."""
    rows = chc.query(
        """
        SELECT toString(player_id), side, map_name,
               countDistinctIf((match_id, round_number), has(inventory, 'AWP')) AS awp_r,
               countDistinct((match_id, round_number)) AS total_r
        FROM player_ticks WHERE is_alive
        GROUP BY player_id, side, map_name
        """
    ).result_rows
    return {(pid, side, mp): (int(a), int(t)) for pid, side, mp, a, t in rows}


def _lurk(chc) -> dict[Key, tuple[float, int]]:
    """İlk 30 sn'de takım merkezine ortalama uzaklık (world unit) + örnek sayısı."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number, side, map_name,
               toUInt16(floor(round_time)) AS s,
               toString(player_id), any(x), any(y)
        FROM player_ticks
        WHERE is_alive AND round_time >= 0 AND round_time < 30
        GROUP BY match_id, round_number, side, map_name, s, player_id
        """
    ).result_rows
    bucket: dict[tuple, list[tuple[str, float, float]]] = defaultdict(list)
    for mid, rn, side, mp, s, pid, x, y in rows:
        bucket[(mid, rn, side, mp, s)].append((pid, x, y))
    acc: dict[Key, list[float]] = defaultdict(list)
    for (_mid, _rn, side, mp, _s), plist in bucket.items():
        if len(plist) < 3:
            continue
        cx = sum(p[1] for p in plist) / len(plist)
        cy = sum(p[2] for p in plist) / len(plist)
        for pid, x, y in plist:
            acc[(pid, side, mp)].append(((x - cx) ** 2 + (y - cy) ** 2) ** 0.5)
    return {k: (sum(v) / len(v), len(v)) for k, v in acc.items() if v}


def _anchor(chc) -> dict[Key, tuple[str, float]]:
    """(player, side, map) → (en çok işgal edilen yer, işgal payı)."""
    rows = chc.query(
        """
        SELECT toString(player_id), side, map_name, place, count() AS c
        FROM player_ticks
        WHERE is_alive AND place != '' AND round_time > 15  -- spawn/freeze sayılmaz
        GROUP BY player_id, side, map_name, place
        """
    ).result_rows
    per_key: dict[Key, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for pid, side, mp, place, c in rows:
        per_key[(pid, side, mp)][place] += c
    out = {}
    for key, places in per_key.items():
        tot = sum(places.values())
        top_place, top_c = max(places.items(), key=lambda kv: kv[1])
        out[key] = (top_place, top_c / tot if tot else 0.0)
    return out


# Kurtuluş Yok Tek Başına, Ya Hep Beraber Ya Hiçbirimiz
def run(pgconn, chc) -> int:
    base = _rounds_played(pgconn)
    opens = _openings(pgconn)
    util = _util(pgconn)
    awp = _awp_counts(chc)
    lurk = _lurk(chc)
    anchor = _anchor(chc)

    # Genel ('' harita) satırlar: harita satırlarından toplanır
    maps_of: dict[tuple[str, str], list[str]] = defaultdict(list)
    for (pid, side, mp) in base:
        maps_of[(pid, side)].append(mp)
    for (pid, side), mps in maps_of.items():
        tot = {"rounds": 0, "dmg": 0, "fa": 0, "team": None}
        ok = od = un = aw_r = aw_t = 0
        lk_sum = lk_n = 0.0
        for mp in mps:
            b = base[(pid, side, mp)]
            tot["rounds"] += b["rounds"]; tot["dmg"] += b["dmg"]
            tot["fa"] += b["fa"]; tot["team"] = tot["team"] or b["team"]
            o = opens.get((pid, side, mp))
            if o:
                ok += o["ok"]; od += o["od"]
            un += util.get((pid, side, mp), 0)
            a = awp.get((pid, side, mp))
            if a:
                aw_r += a[0]; aw_t += a[1]
            l = lurk.get((pid, side, mp))
            if l:
                lk_sum += l[0] * l[1]; lk_n += l[1]
        base[(pid, side, "")] = tot
        opens[(pid, side, "")] = {"ok": ok, "od": od}
        util[(pid, side, "")] = un
        awp[(pid, side, "")] = (aw_r, aw_t)
        if lk_n:
            lurk[(pid, side, "")] = (lk_sum / lk_n, int(lk_n))
        # genel çapa: en çok raunt oynanan haritanın çapası — etikete harita
        # adı eklenir ("hangi haritada?" sorusu genel görünümde de cevaplı)
        best_mp = max(mps, key=lambda m: base[(pid, side, m)]["rounds"])
        if (pid, side, best_mp) in anchor:
            place, share = anchor[(pid, side, best_mp)]
            anchor[(pid, side, "")] = (f"{place} ({best_mp.replace('de_', '')})", share)

    # Lurk eşiği: (taraf, harita) başına medyan — geometriler karışmaz
    lurk_median: dict[tuple[str, str], float] = {}
    sm_vals: dict[tuple[str, str], list[float]] = defaultdict(list)
    for (pid, side, mp), (v, _n) in lurk.items():
        if base.get((pid, side, mp), {}).get("rounds", 0) >= MIN_ROUNDS:
            sm_vals[(side, mp)].append(v)
    for k, vals in sm_vals.items():
        lurk_median[k] = statistics.median(vals) if vals else 0.0

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM player_roles")
        for (pid, side, mp), b in sorted(base.items()):
            n = b["rounds"]
            o = opens.get((pid, side, mp), {"ok": 0, "od": 0})
            attempts = o["ok"] + o["od"]
            entry_share = attempts / n if n else None
            entry_success = o["ok"] / attempts if attempts else None
            lk = lurk.get((pid, side, mp))
            an = anchor.get((pid, side, mp))
            aw_r, aw_t = awp.get((pid, side, mp), (0, 0))
            aw = aw_r / aw_t if aw_t else 0.0
            upr = util.get((pid, side, mp), 0) / n if n else None
            fapr = b["fa"] / n if n else None
            adr = b["dmg"] / n if n else None

            tags: list[str] = []
            if n >= MIN_ROUNDS:
                if side == "T" and entry_share is not None and entry_share > ENTRY_SHARE:
                    tags.append("ENTRY")
                med = lurk_median.get((side, mp), 0.0)
                if side == "T" and lk is not None and med > 0 and lk[0] > med * LURK_FACTOR:
                    tags.append("LURKER")
                if side == "CT" and an is not None and an[1] > ANCHOR_SHARE:
                    tags.append(f"ANCHOR:{an[0]}")
                if aw > AWP_SHARE:
                    tags.append("AWP")

            cur.execute(
                """
                INSERT INTO player_roles
                    (player_id, team_id, side, map_name, rounds, entry_attempt_share,
                     entry_success, opening_kills, opening_deaths, lurk_dist_avg,
                     anchor_place, anchor_share, awp_round_share, util_per_round,
                     flash_assists_pr, adr, tags)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    pid, b["team"], side, mp, n, entry_share, entry_success,
                    o["ok"], o["od"], lk[0] if lk else None,
                    an[0] if an else None, an[1] if an else None,
                    aw, upr, fapr, adr, tags,
                ),
            )
            inserted += 1
    pgconn.commit()
    return inserted
