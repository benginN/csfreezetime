"""Turnuva etiketi rafinasyonu.

Backfill, matches.tournament'a arşiv adının ham slug'ını yazar:
"iem-cologne-major-2026-9z-vs-furia". Takım adları parse SONRASI
bilindiğinden ayıklama burada yapılır: "{slugA}-vs-{slugB}" kuyruğu
bulunur ve atılır → "iem-cologne-major-2026". Desen bulunamazsa ham
slug korunur (dürüstlük: uydurma yok). İdempotent — her koşuda tüm
maçlar yeniden hesaplanır.

Birincil çapa event_name'dir (demo dosya slug'ı, "a-vs-b-mN-harita[-pN]"):
arşiv adındaki takım kuyruğu ile aynı yazımı taşır, kulüp adının DB'deki
yazımından ("Team Vitality" ↔ "vitality") bağımsızdır. Takım-adı eşleşmesi
yalnız yedek yoldur.
"""

from __future__ import annotations

import re


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _spans(x: str) -> list[str]:
    """Slug'ın tüm ardışık token-aralıkları: "lynn-vision-gaming" →
    [lynn, lynn-vision, ..., vision-gaming, gaming]; HLTV kısaltmaları
    ("Team Vitality" → "vitality") böyle yakalanır. Arşiv adı artikel
    taşıyabilir ("the-mongolz") ama kulüp adı taşımayabilir ("MongolZ")
    — "the-" varyantı da aday olur."""
    toks = x.split("-")
    cands = [
        "-".join(toks[i : j + 1])
        for i in range(len(toks))
        for j in range(i, len(toks))
    ]
    cands += ["the-" + c for c in cands if not c.startswith("the-")]
    return cands


def _event_tails(event_name: str | None) -> list[str]:
    """Demo slug'ından "-vs-" içeren kuyruk adayları, uzundan kısaya.

    "vitality-vs-mouz-m2-train-p1" → ["vitality-vs-mouz-m2-train-p1",
    ..., "vitality-vs-mouz"]. Harita/mN/pN ekleri arşiv adında olmadığından
    uzun adaylar tutmaz; ilk tutan (en uzun) doğru kesim yeridir.
    """
    if not event_name or "-vs-" not in event_name:
        return []
    toks = event_name.split("-")
    tails = []
    for j in range(len(toks), 0, -1):
        cand = "-".join(toks[:j])
        if "-vs-" not in cand:
            break
        tails.append(cand)
    return tails


def run(pgconn) -> int:
    with pgconn.cursor() as cur:
        cur.execute(
            """
            SELECT m.match_id, m.tournament, m.event_name, ta.name, tb.name
            FROM matches m
            LEFT JOIN teams ta ON ta.team_id = m.team_a_id
            LEFT JOIN teams tb ON tb.team_id = m.team_b_id
            WHERE m.tournament IS NOT NULL AND m.status = 'ready'
            """
        )
        rows = cur.fetchall()

    updates: list[tuple[str, str]] = []
    refined_events: set[str] = set()
    pending: list[tuple[str, str]] = []  # (match_id, raw)
    for match_id, raw, event_name, name_a, name_b in rows:
        refined = None

        # 0. geçiş — event_name çapası: demo slug'ındaki "a-vs-b" kuyruğu
        # arşiv adıyla aynı yazımı taşır; kulüp adı yazımından bağımsızdır
        # ("Team Vitality" DB'de, arşivde yalnız "vitality" — 1. geçiş
        # bunu ıskalıyordu). En uzun tutan aday doğru kesim yeridir.
        for cand in _event_tails(event_name):
            idx = raw.find("-" + cand)
            if idx > 0:
                refined = raw[:idx]
                break

        # 1. geçiş (yedek) — takım adlarıyla kuyruk kesme.
        if refined is None and name_a and name_b:
            cands_a = _spans(_slug(name_a))
            cands_b = _spans(_slug(name_b))
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

    # 3. geçiş — tarihi kalıntı onarımı: "-vs-" içermeyen ama bilinen temiz
    # bir etkinliği takım-adı kırıntısıyla uzatan değerler o etkinliğe
    # bağlanır (eski koşuların "…rotterdam-2026-the" kalıntısı gibi).
    # Kırıntı o maçın takım adlarının token-aralığı DEĞİLSE dokunulmaz —
    # "…-season-1-finals" gibi gerçek alt etkinlikler güvende kalır.
    # (raw kendisi de refined_events'te olabilir — 2a her non-vs değeri
    # ekler; kalıntıyı "temiz" sanmamak için üyeliğe BAKILMAZ, daha kısa
    # bir etkinliğin öneki olması yeterlidir.) Kırıntı adayları hem DB
    # kulüp adlarından hem event_name'in vs-çekirdeğinden türer: arşiv
    # yazımı DB'den sapabilir ("MongolZ" ↔ "the-mongolz"). Yarıda kesilmiş
    # parça için token-sınırlı önek de kabul ("the" ⊂ "the-mongolz").
    done = {mid for _, mid in updates}
    for match_id, raw, event_name, name_a, name_b in rows:
        if match_id in done or "-vs-" in raw:
            continue
        frags = set()
        if name_a:
            frags.update(_spans(_slug(name_a)))
        if name_b:
            frags.update(_spans(_slug(name_b)))
        tails_ev = _event_tails(event_name)
        if tails_ev:
            for side in tails_ev[-1].split("-vs-"):
                frags.update(_spans(side))
        for ev in sorted(refined_events, key=len, reverse=True):
            if not raw.startswith(ev + "-"):
                continue
            tail = raw[len(ev) + 1 :]
            if tail in frags or any(f.startswith(tail + "-") for f in frags):
                updates.append((ev, match_id))
                break

    if updates:
        with pgconn.cursor() as cur:
            cur.executemany(
                "UPDATE matches SET tournament = %s WHERE match_id = %s", updates
            )
        pgconn.commit()
    return len(updates)
