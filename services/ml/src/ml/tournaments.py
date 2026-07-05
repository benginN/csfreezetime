"""Turnuva etiketi rafinasyonu.

Backfill, matches.tournament'a arşiv adının ham slug'ını yazar:
"iem-cologne-major-2026-9z-vs-furia". Takım adları parse SONRASI
bilindiğinden ayıklama burada yapılır: "{slugA}-vs-{slugB}" (iki yönde)
kuyruğu bulunur ve atılır → "iem-cologne-major-2026". Desen bulunamazsa
ham slug korunur (dürüstlük: uydurma yok). İdempotent — her koşuda tüm
maçlar yeniden hesaplanır (ham slug event kaydı olarak arşiv adında
zaten korunur; burada yalnız tournament kolonu normalize edilir).
"""

from __future__ import annotations

import re


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def run(pgconn) -> int:
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT m.match_id, m.tournament, ta.name, tb.name
            FROM matches m
            LEFT JOIN teams ta ON ta.team_id = m.team_a_id
            LEFT JOIN teams tb ON tb.team_id = m.team_b_id
            WHERE m.tournament IS NOT NULL AND m.status = 'ready'
            """
        )
        rows = cur.fetchall()

    # 1. geçiş — takım adlarıyla kuyruk kesme. Kulüp adı HLTV slug'ından
    # uzun olabilir ("BetBoom Team" ↔ "betboom"); tam slug tutmazsa ilk
    # token'ıyla da denenir.
    updates: list[tuple[str, str]] = []
    refined_events: set[str] = set()
    pending: list[tuple[str, str]] = []  # (match_id, raw)
    for match_id, raw, name_a, name_b in rows:
        refined = None
        if name_a and name_b:
            a, b = _slug(name_a), _slug(name_b)
            # slug'ın tüm token-önekleri aday: "lynn-vision-gaming" →
            # [lynn, lynn-vision, lynn-vision-gaming] (HLTV kısaltmaları).
            # HLTV arşiv adı artikel taşıyabilir ("the-mongolz") ama kulüp
            # adı taşımayabilir ("MongolZ") — "the-" varyantı da aday olur.
            def prefixes(x: str) -> list[str]:
                toks = x.split("-")
                cands = ["-".join(toks[: i + 1]) for i in range(len(toks))]
                cands += ["the-" + c for c in cands if not c.startswith("the-")]
                return cands
            cands_a = prefixes(a)
            cands_b = prefixes(b)
            tails = [f"-{x}-vs-{y}" for x in cands_a for y in cands_b]
            tails += [f"-{y}-vs-{x}" for x in cands_a for y in cands_b]
            # En ERKEN başlayan kuyruk kazanır: kısa aday takım adının
            # ortasından yakalarsa ("mongolz" ⊂ "the-mongolz") artikel
            # turnuva adına yapışıyordu ("...rotterdam-2026-the" vakası).
            best = None
            for tail in tails:
                idx = raw.find(tail)
                if idx > 0 and (best is None or idx < best):
                    best = idx
            if best is not None:
                refined = raw[:best]
        if refined and refined != raw:
            updates.append((refined, match_id))
            refined_events.add(refined)
        elif "-vs-" in raw:
            pending.append((match_id, raw))

    # 2a. geçiş — DB'deki temiz etkinlik adları da konsensüse katılır
    # (önceki koşularda doğrulanmış, '-vs-' içermeyen değerler)
    with pgconn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT tournament FROM matches "
            "WHERE tournament IS NOT NULL AND tournament NOT LIKE '%-vs-%'"
        )
        refined_events.update(r[0] for r in cur.fetchall())

    # 2. geçiş — konsensüs: doğrulanan etkinlik adlarından
    # biriyle başlayan kalıntılar aynı etkinliğe bağlanır.
    for match_id, raw in pending:
        for ev in sorted(refined_events, key=len, reverse=True):
            if raw.startswith(ev + "-"):
                updates.append((ev, match_id))
                break

    if updates:
        with pgconn.cursor() as cur:
            cur.executemany(
                "UPDATE matches SET tournament = %s WHERE match_id = %s", updates
            )
        pgconn.commit()
    return len(updates)
