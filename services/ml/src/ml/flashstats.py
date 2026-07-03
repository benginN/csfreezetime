"""Flash etkinliği: player_blind olayı bu demolarda yok; onun yerine
player_ticks.flash_remaining SIÇRAMALARINDAN türetilir.

Mantık: bir oyuncunun flash_remaining değeri bir örnekten diğerine
+RISE_MIN'den fazla artıyorsa o anda kör edilmiştir; artışın kendisi
(yaklaşık) körlük süresidir. Sıçrama, ±WINDOW tick içindeki en yakın
flash patlamasına atfedilir. grenades tablosundaki enemies_flashed /
teammates_flashed / total_enemy_blind_time alanları güncellenir.

Dürüstlük notu: 16 Hz örnekleme yüzünden ~0.3 sn altı körlükler sayılmaz;
aynı ana denk gelen iki flash'ta atama en yakın patlamaya yapılır.
"""

from __future__ import annotations

from collections import defaultdict

RISE_MIN = 0.3      # sn — bundan küçük artış gürültü sayılır
WINDOW = 16         # tick — sıçrama ↔ patlama eşleme penceresi (0.25 sn)


def _flash_dets(pgconn) -> dict[str, list[tuple]]:
    """match_id → [(round, det_tick, side, grenade_id)] (yalnız flash)."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT g.match_id::text, g.round_number, g.detonate_tick, g.side, g.grenade_id
            FROM grenades g JOIN matches m ON m.match_id = g.match_id
            WHERE g.type = 'flash' AND m.status = 'ready' AND g.side IN ('T','CT')
            ORDER BY g.match_id, g.detonate_tick
            """
        )
        out: dict[str, list] = defaultdict(list)
        for mid, rn, dt, side, gid in cur.fetchall():
            out[mid].append((rn, dt, side, gid))
        return out


def _rises(chc) -> dict[tuple[str, int], list[tuple[int, str, float]]]:
    """(match, round) → [(tick, taraf, artış)] — flash_remaining sıçramaları."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number, toString(player_id), side,
               tick, flash_remaining
        FROM player_ticks
        WHERE flash_remaining > 0
        ORDER BY match_id, round_number, player_id, tick
        """
    ).result_rows
    # oyuncu bazında ardışık örnek karşılaştırması
    out: dict[tuple, list] = defaultdict(list)
    prev_key = None
    prev_tick = 0
    prev_val = 0.0
    for mid, rn, pid, side, tick, f in rows:
        key = (mid, rn, pid)
        if key != prev_key or tick - prev_tick > 8:
            # yeni seri: sıfırdan f'e çıkış = sıçrama
            rise = f
        else:
            rise = f - prev_val
        if rise > RISE_MIN:
            out[(mid, rn)].append((tick, side, rise))
        prev_key, prev_tick, prev_val = key, tick, f
    return out


def run(pgconn, chc) -> tuple[int, int]:
    dets = _flash_dets(pgconn)
    rises = _rises(chc)

    # grenade_id → sayaçlar
    agg: dict[int, list[float]] = defaultdict(lambda: [0, 0, 0.0])  # ef, tf, ebt
    matched = 0
    for mid, flashes in dets.items():
        for rn, r_list in [
            (rn, rises.get((mid, rn), [])) for rn in {f[0] for f in flashes}
        ]:
            round_flashes = [f for f in flashes if f[0] == rn]
            for tick, side, rise in r_list:
                # en yakın patlama (±WINDOW; 16 Hz örnekleme gecikmesi payıyla)
                best, best_d = None, WINDOW + 4
                for _rn, dt, fside, gid in round_flashes:
                    d = abs(tick - dt)
                    if d < best_d:
                        best, best_d = (fside, gid), d
                if best is None:
                    continue
                fside, gid = best
                if side == fside:
                    agg[gid][1] += 1
                else:
                    agg[gid][0] += 1
                    agg[gid][2] += rise
                matched += 1

    with pgconn.cursor() as cur:
        cur.execute(
            "UPDATE grenades SET enemies_flashed=0, teammates_flashed=0, "
            "total_enemy_blind_time=0 WHERE type='flash'"
        )
        for gid, (ef, tf, ebt) in agg.items():
            cur.execute(
                """
                UPDATE grenades SET enemies_flashed=%s, teammates_flashed=%s,
                       total_enemy_blind_time=%s WHERE grenade_id=%s
                """,
                (int(ef), int(tf), ebt, gid),
            )
    pgconn.commit()
    return len(agg), matched
