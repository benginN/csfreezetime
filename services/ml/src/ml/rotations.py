"""Rotasyon analizi (setups v2): kurulum, ilk temastan sonra nasıl bozuluyor?

Her (takım, harita, taraf, desen, pozisyon) için: o pozisyon doluyken ilk
temas geldiğinde oyuncu ROT_WINDOW içinde yerinden ayrıldı mı, ne kadar
gecikmeyle, en sık nereye? "B anchor'u temasların %38'inde Connector'a
kayıyor" çıktısını üretir. Tamamen deterministik; pozisyon başına
MIN_CONTACTS altındaki satırlar yazılmaz (§10).

Not (v1 dürüst basitleştirme): rotasyon oranı temasın NEREDE olduğuna göre
ayrıştırılmaz — örneklem yerleşim başına yeterince kalın kalsın diye.
"""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict

from . import setups

ROT_WINDOW = 12    # sn — temas sonrası bu pencerede yer değişimi = rotasyon
MIN_CONTACTS = 5
SETUP_OFFSET = 15  # sn — desen anı (team_setups t_offset=15 ile aynı)
HORIZON = 90       # sn — yer serisi bu ufka kadar okunur


def _first_kills(pgconn) -> dict[tuple[str, int], float]:
    """(match, round) → ilk temas saniyesi (freeze-end'e göre)."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT k.match_id::text, k.round_number,
                   (k.tick - r.freeze_end_tick) / 64.0
            FROM kills k
            JOIN rounds r ON (r.match_id, r.round_number) = (k.match_id, k.round_number)
            JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
            WHERE k.is_first_kill AND r.freeze_end_tick IS NOT NULL
            """
        )
        return {(mid, rn): sec for mid, rn, sec in cur.fetchall()}


def _stored_patterns(pgconn) -> dict[tuple[str, str, str], dict[tuple, int]]:
    """(team, map, side) → {desen anahtarı: pattern_id} (t_offset=15)."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT team_id::text, map_name, side, pattern_id, pattern
            FROM team_setups WHERE t_offset = %s
            """,
            (SETUP_OFFSET,),
        )
        out: dict[tuple, dict] = defaultdict(dict)
        for team, map_name, side, pid, pattern in cur.fetchall():
            key = tuple(sorted(
                p for e in pattern for p in [e["place"]] * e["n"]
            ))
            out[(team, map_name, side)][key] = pid
        return out


def _place_series(chc, map_name: str) -> dict[tuple[str, int, str], list[tuple[int, str]]]:
    """(match, round, player) → [(sec, yer)] (1 Hz, taraf bilgisiyle ayrı)."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number, toString(player_id), side,
               toUInt16(floor(round_time)) AS sec_b, any(place) AS plc
        FROM player_ticks
        WHERE map_name = %(m)s AND is_alive AND place != ''
          AND round_time >= %(lo)s AND round_time < %(hi)s
        GROUP BY match_id, round_number, player_id, side, sec_b
        ORDER BY match_id, round_number, player_id, sec_b
        """,
        parameters={"m": map_name, "lo": SETUP_OFFSET - 1, "hi": HORIZON},
    ).result_rows
    out: dict[tuple, list] = defaultdict(list)
    sides: dict[tuple, str] = {}
    for mid, rn, pid, side, sec, plc in rows:
        out[(mid, rn, pid)].append((sec, plc))
        sides[(mid, rn, pid)] = side
    return out, sides  # type: ignore[return-value]


def run(pgconn, chc) -> int:
    kills = _first_kills(pgconn)
    patterns = _stored_patterns(pgconn)
    rteams = setups._round_teams(pgconn)
    maps = sorted({k[1] for k in patterns})

    # (team, map, side, pid, place) → gözlemler
    obs: dict[tuple, list[tuple[bool, float | None, str | None]]] = defaultdict(list)

    for map_name in maps:
        series, sides = _place_series(chc, map_name)
        pos15 = setups._positions_at(chc, map_name, SETUP_OFFSET)
        # raunt → oyuncu bazlı seriler
        by_round: dict[tuple, list[tuple[str, list]]] = defaultdict(list)
        for (mid, rn, pid), sam in series.items():
            by_round[(mid, rn)].append((pid, sam))

        for (mid, rn, side), plist in pos15.items():
            meta = rteams.get((mid, rn, side))
            if not meta or meta[0] != map_name or len(plist) < 4:
                continue
            team = meta[1]
            key = tuple(sorted(plist))
            pid_ = patterns.get((team, map_name, side), {}).get(key)
            if pid_ is None:
                continue
            contact = kills.get((mid, rn))
            if contact is None or contact < SETUP_OFFSET:
                continue  # temas kurulumdan önceyse desen zaten oturmadı
            for player, sam in by_round[(mid, rn)]:
                if sides.get((mid, rn, player)) != side:
                    continue
                # kurulum yeri: SETUP_OFFSET anındaki yer
                setup_place = None
                for sec, plc in sam:
                    if sec >= SETUP_OFFSET:
                        setup_place = plc
                        break
                if setup_place is None:
                    continue
                # temas sonrası pencere: yer değişimi (2 ardışık sn — jiggle eleme)
                rotated, delay, dest = False, None, None
                prev_diff = None
                for sec, plc in sam:
                    if sec <= contact or sec > contact + ROT_WINDOW + 1:
                        continue
                    if plc != setup_place:
                        if prev_diff == plc:  # ikinci ardışık farklı örnek
                            rotated = True
                            delay = sec - contact
                            dest = plc
                            break
                        prev_diff = plc
                    else:
                        prev_diff = None
                obs[(team, map_name, side, pid_, setup_place)].append(
                    (rotated, delay, dest)
                )

    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM setup_rotations")
        for (team, map_name, side, pid_, place), rows in sorted(obs.items()):
            n = len(rows)
            if n < MIN_CONTACTS:
                continue
            rot = [r for r in rows if r[0]]
            delays = [r[1] for r in rot if r[1] is not None]
            dests = Counter(r[2] for r in rot if r[2])
            cur.execute(
                """
                INSERT INTO setup_rotations
                    (team_id, map_name, side, pattern_id, place,
                     n_contacts, rotations, rotate_rate, med_delay_sec, dest_mix)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    team, map_name, side, pid_, place,
                    n, len(rot), len(rot) / n,
                    statistics.median(delays) if delays else None,
                    json.dumps(dict(dests.most_common(3))),
                ),
            )
            inserted += 1
    pgconn.commit()
    return inserted
