"""Tahmin dağılımı yardımcıları (§6.2 Aşama 2, veri-azlığına dürüst sürüm).

Hiyerarşik büzülme zinciri:
    p_lig(küme)          = lig frekansı (harita+taraf)
    p_takım(küme)        = (n_t·f_t + K_TEAM·p_lig) / (n_t + K_TEAM)
    p_takım+buy(küme)    = (n_tb·f_tb + K_BUY·p_takım) / (n_tb + K_BUY)

LightGBM burada BİLEREK yok: lig geneli ≥50 bin raunt eşiğine (§7.2)
ulaşıldığında evaluate.py düzeneğine aday model olarak eklenecek —
taban çizgiyi zamansal test setinde geçemeyen model API'ye çıkmaz (§6.2).
"""

from __future__ import annotations

from collections import Counter, defaultdict

K_TEAM = 20   # takım → lig büzülmesi (tendencies.SHRINK_K ile aynı)
K_BUY = 10    # takım+buy → takım büzülmesi

Row = tuple  # (map_name, side, team_id, buy_type, cluster_id)


def league_dist(rows: list[Row], map_name: str, side: str) -> dict[int, float]:
    c = Counter(r[4] for r in rows if r[0] == map_name and r[1] == side)
    total = sum(c.values())
    return {k: v / total for k, v in c.items()} if total else {}


def team_dist(rows: list[Row], map_name: str, side: str, team_id) -> dict[int, float]:
    lig = league_dist(rows, map_name, side)
    c = Counter(r[4] for r in rows if r[0] == map_name and r[1] == side and r[2] == team_id)
    n = sum(c.values())
    return {
        k: (n * (c.get(k, 0) / n if n else 0.0) + K_TEAM * p) / (n + K_TEAM)
        for k, p in lig.items()
    }


def team_buy_dist(rows: list[Row], map_name: str, side: str, team_id, buy: str) -> dict[int, float]:
    base = team_dist(rows, map_name, side, team_id)
    c = Counter(
        r[4] for r in rows
        if r[0] == map_name and r[1] == side and r[2] == team_id and r[3] == buy
    )
    n = sum(c.values())
    return {
        k: (n * (c.get(k, 0) / n if n else 0.0) + K_BUY * p) / (n + K_BUY)
        for k, p in base.items()
    }


def counts_by_team_buy(rows: list[Row]) -> dict[tuple, Counter]:
    out: dict[tuple, Counter] = defaultdict(Counter)
    for map_name, side, team_id, buy, cluster in rows:
        if buy is not None:
            out[(team_id, map_name, side, buy)][cluster] += 1
    return out
