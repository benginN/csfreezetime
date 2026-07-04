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
            cands_a = [a] if "-" not in a else [a, a.split("-")[0]]
            cands_b = [b] if "-" not in b else [b, b.split("-")[0]]
            tails = [f"-{x}-vs-{y}" for x in cands_a for y in cands_b]
            tails += [f"-{y}-vs-{x}" for x in cands_a for y in cands_b]
            for tail in tails:
                idx = raw.find(tail)
                if idx > 0:
                    refined = raw[:idx]
                    break
        if refined and refined != raw:
            updates.append((refined, match_id))
            refined_events.add(refined)
        elif "-vs-" in raw:
            pending.append((match_id, raw))

    # 2. geçiş — konsensüs: 1. geçişte doğrulanan etkinlik adlarından
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
