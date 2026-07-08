"""Raunt kazanma olasılığı: durum → tarihsel T-kazanma oranı.

Durum = (canlı T, canlı CT, bomba kuruldu mu, zaman kovası). Tamamen sayım;
ince hücreler hiyerarşik büzülmeyle ebeveyne çekilir (§10: dürüst istatistik):
    hücre → (canlılar, bomba) toplamı → (canlılar) toplamı → global.
Ayrıca raunt başına zirve olasılıklar yazılır (throw tespiti: bir taraf
%70+'a ulaşıp raundu kaybettiyse "atılmış raunt").

Zaman kovaları: kurulum ÖNCESİ kalan süreye göre 0-3
(>75, 45-75, 20-45, <20 sn kaldı); kurulum SONRASI geçen süreye göre 4-6
(0-10, 10-25, >25 sn).
"""

from __future__ import annotations

from collections import defaultdict

SHRINK_K = 25
ROUND_SECONDS = 115


def tbucket(sec: float, plant_sec: float | None) -> int:
    if plant_sec is not None and sec >= plant_sec:
        dt = sec - plant_sec
        if dt < 10:
            return 4
        if dt < 25:
            return 5
        return 6
    remaining = ROUND_SECONDS - sec
    if remaining > 75:
        return 0
    if remaining > 45:
        return 1
    if remaining > 20:
        return 2
    return 3


def _round_meta(pgconn) -> dict[tuple[str, int], tuple[str, float | None]]:
    """(match, round) → (kazanan taraf, bomba kurulum saniyesi)."""
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT r.match_id::text, r.round_number, r.winner_side,
                   CASE WHEN r.bomb_plant_tick IS NOT NULL AND r.freeze_end_tick IS NOT NULL
                        THEN (r.bomb_plant_tick - r.freeze_end_tick) / 64.0 END
            FROM rounds r JOIN matches m ON m.match_id = r.match_id
            WHERE m.status = 'ready' AND r.winner_side IN ('T','CT')
            """
        )
        return {(mid, rn): (w, ps) for mid, rn, w, ps in cur.fetchall()}


def _alive_series(chc) -> dict[tuple[str, int], list[tuple[int, int, int]]]:
    """(match, round) → [(sec, canlı T, canlı CT)] (1 Hz)."""
    rows = chc.query(
        """
        SELECT toString(match_id), round_number,
               toUInt16(floor(round_time)) AS sec,
               countDistinctIf(player_id, side = 'T' AND is_alive)  AS at,
               countDistinctIf(player_id, side = 'CT' AND is_alive) AS act
        FROM player_ticks
        WHERE round_time >= 0 AND round_time < %(total)s
        GROUP BY match_id, round_number, sec
        ORDER BY match_id, round_number, sec
        """,
        parameters={"total": ROUND_SECONDS},
    ).result_rows
    out: dict[tuple, list] = defaultdict(list)
    for mid, rn, sec, at, act in rows:
        out[(mid, rn)].append((sec, at, act))
    return out


# İmamoğlu'na Özgürlük
def run(pgconn, chc) -> tuple[int, int]:
    meta = _round_meta(pgconn)
    series = _alive_series(chc)

    # sayımlar: hücre + ebeveynler
    cell: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])        # (at,act,bomb,tb)
    par_bomb: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])    # (at,act,bomb)
    par_alive: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])   # (at,act)
    glob = [0, 0]
    peaks: dict[tuple, list[float]] = {}

    for key, samples in series.items():
        m = meta.get(key)
        if not m:
            continue
        winner, plant_sec = m
        t_won = winner == "T"
        for sec, at, act in samples:
            if at == 0 and act == 0:
                continue
            bomb = plant_sec is not None and sec >= plant_sec
            tb = tbucket(sec, plant_sec)
            for d, k in (
                (cell, (at, act, bomb, tb)),
                (par_bomb, (at, act, bomb)),
                (par_alive, (at, act)),
            ):
                d[k][0] += 1 if t_won else 0
                d[k][1] += 1
            glob[0] += 1 if t_won else 0
            glob[1] += 1

    p_glob = glob[0] / glob[1] if glob[1] else 0.5

    def shrunk(w: int, n: int, parent: float) -> float:
        return (w + SHRINK_K * parent) / (n + SHRINK_K)

    # tablo yaz + arama fonksiyonu kur
    lookup: dict[tuple, float] = {}
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM winprob_table")
        for (at, act, bomb, tb), (w, n) in sorted(cell.items()):
            pa = shrunk(*par_alive[(at, act)], p_glob)
            pb = shrunk(*par_bomb[(at, act, bomb)], pa)
            p = shrunk(w, n, pb)
            lookup[(at, act, bomb, tb)] = p
            cur.execute(
                """
                INSERT INTO winprob_table (alive_t, alive_ct, bomb, tbucket, t_wins, n, p)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                """,
                (at, act, bomb, tb, w, n, p),
            )

        # raunt zirveleri (throw tespiti için)
        cur.execute("DELETE FROM round_winprob")
        n_peaks = 0
        for key, samples in series.items():
            m = meta.get(key)
            if not m:
                continue
            _, plant_sec = m
            mx_t, mx_ct = 0.0, 0.0
            for sec, at, act in samples:
                if at == 0 and act == 0:
                    continue
                bomb = plant_sec is not None and sec >= plant_sec
                p = lookup.get((at, act, bomb, tbucket(sec, plant_sec)))
                if p is None:
                    continue
                mx_t = max(mx_t, p)
                mx_ct = max(mx_ct, 1 - p)
            cur.execute(
                """
                INSERT INTO round_winprob (match_id, round_number, max_t_prob, max_ct_prob)
                VALUES (%s,%s,%s,%s)
                """,
                (key[0], key[1], mx_t, mx_ct),
            )
            n_peaks += 1
            peaks[key] = [mx_t, mx_ct]
    pgconn.commit()
    return len(cell), n_peaks
