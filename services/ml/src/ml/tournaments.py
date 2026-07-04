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

    updates: list[tuple[str, str]] = []
    for match_id, raw, name_a, name_b in rows:
        if not (name_a and name_b):
            continue
        a, b = _slug(name_a), _slug(name_b)
        refined = None
        for tail in (f"-{a}-vs-{b}", f"-{b}-vs-{a}"):
            idx = raw.find(tail)
            if idx > 0:
                refined = raw[:idx]
                break
        if refined and refined != raw:
            updates.append((refined, match_id))

    if updates:
        with pgconn.cursor() as cur:
            cur.executemany(
                "UPDATE matches SET tournament = %s WHERE match_id = %s", updates
            )
        pgconn.commit()
    return len(updates)
