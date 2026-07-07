"""Takım kimliği birleştirme (alias merge).

HLTV/GOTV kayıtlarında aynı org farklı clan adlarıyla görünür
("Team Vitality" / "Vitality", "NAVI" / "Natus Vincere") ve rauntlar
kimlikler arasında bölünür — eşikler (kurulum ≥8, roller ≥30) sahte
"yetersiz veri"ye düşer. Kural (muhafazakâr, deterministik):

  birleştir ⇔ kadro örtüşmesi ≥ 4 oyuncu
            VEYA (örtüşme ≥ 2 VE normalize ad eşit)

Akademi takımları (örtüşme ≤1) ve ad benzeri farklı orglar (FUT/FURIA
normları farklı) birleşmez. Kanonik kimlik = en çok maçı olan; diğer
kimliklerin matches/rounds/players referansları ona taşınır, boş kalan
teams satırı silinir. İdempotent — her koşuda yeniden değerlendirilir.
"""

from __future__ import annotations

import re
from collections import defaultdict


def _norm(name: str) -> str:
    # tüm ayraç/noktalama düşer ("Virtus.pro_"→"virtuspro", "[B8]"→"b8"),
    # baş artikel düşer ("The MongolZ"→"mongolz"), org ekleri düşer
    n = re.sub(r"[^a-z0-9]+", "", name.lower())
    n = re.sub(r"^the", "", n)
    for w in ("team", "esports", "esport", "gaming", "clan"):
        n = n.replace(w, "")
    return n


def run(pgconn) -> int:
    with pgconn.cursor() as cur:
        cur.execute("SELECT team_id, name FROM teams")
        teams = cur.fetchall()
        # takım kadrosu: o takım adına sahada görünen oyuncular (≥3 raunt)
        cur.execute(
            """
            SELECT x.team_id, s.player_id
            FROM player_round_states s
            JOIN rounds r ON (r.match_id, r.round_number) = (s.match_id, s.round_number)
            CROSS JOIN LATERAL (VALUES
                (CASE WHEN s.side = 'T' THEN r.t_team_id ELSE r.ct_team_id END)
            ) AS x(team_id)
            WHERE x.team_id IS NOT NULL
            GROUP BY x.team_id, s.player_id
            HAVING count(*) >= 3
            """
        )
        roster = defaultdict(set)
        for tid, pid in cur.fetchall():
            roster[tid].add(pid)
        # maç sayısı (kanonik seçimi)
        cur.execute(
            """
            SELECT t.team_id, count(DISTINCT m.match_id)
            FROM teams t LEFT JOIN matches m
              ON (m.team_a_id = t.team_id OR m.team_b_id = t.team_id)
            GROUP BY t.team_id
            """
        )
        mcount = dict(cur.fetchall())

    ids = [t[0] for t in teams]
    name = dict(teams)
    parent = {i: i for i in ids}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            # kanonik: maçı çok olan kök kalsın
            if mcount.get(ra, 0) >= mcount.get(rb, 0):
                parent[rb] = ra
            else:
                parent[ra] = rb

    # KURAL (sertleştirilmiş — v1 kadro-örtüşmesi zincirleme yanlış birleştirdi):
    # yalnız normalize ad EŞİTSE (veya bilinen kısaltma haritasındaysa) VE
    # kadro ≥2 örtüşüyorsa birleştir. Ad eşleşmeden asla birleşmez.
    KNOWN = {  # gözlemlenen resmî kısaltmalar → kanonik norm (_norm ÇIKTISI biçiminde)
        "navi": "natusvincere", "nip": "ninjasinpyjamas", "flc": "falcons",
        "pv": "parivision", "mnglz": "mongolz", "lvg": "lynnvision",
        "9zglobant": "9z", "hotuxvavada": "hotu", "gl": "gamerlegion",
    }
    canon_norm = lambda n: KNOWN.get(_norm(n), _norm(n))
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            if canon_norm(name[a]) != canon_norm(name[b]):
                continue
            ov = len(roster.get(a, set()) & roster.get(b, set()))
            if ov >= 2:
                union(a, b)

    merges = [(tid, find(tid)) for tid in ids if find(tid) != tid]
    if not merges:
        return 0

    with pgconn.cursor() as cur:
        for old, canon in merges:
            cur.execute("UPDATE matches SET team_a_id = %s WHERE team_a_id = %s", (canon, old))
            cur.execute("UPDATE matches SET team_b_id = %s WHERE team_b_id = %s", (canon, old))
            cur.execute("UPDATE rounds SET t_team_id = %s WHERE t_team_id = %s", (canon, old))
            cur.execute("UPDATE rounds SET ct_team_id = %s WHERE ct_team_id = %s", (canon, old))
            cur.execute("UPDATE players SET current_team_id = %s WHERE current_team_id = %s", (canon, old))
            # eski kimliğin ML çıktıları silinir (aynı koşuda kanonikle yeniden hesaplanır)
            for tbl in ("team_tendencies", "team_tendencies_cond", "utility_spots",
                        "team_setups", "player_roles", "setup_rotations",
                        "team_exec_templates"):
                cur.execute(f"DELETE FROM {tbl} WHERE team_id = %s", (old,))
            cur.execute("DELETE FROM teams WHERE team_id = %s", (old,))
            print(f"  alias: {name[old]!r} → {name[canon]!r}")
    pgconn.commit()
    return len(merges)
