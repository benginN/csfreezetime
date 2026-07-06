"""Tahmin dağılımı yardımcıları (§6.2 Aşama 2, veri-azlığına dürüst sürüm).

Hiyerarşik büzülme zinciri:
    p_lig(küme)          = lig frekansı (harita+taraf)
    p_takım(küme)        = (n_t·f_t + K_TEAM·p_lig) / (n_t + K_TEAM)
    p_takım+buy(küme)    = (n_tb·f_tb + K_BUY·p_takım) / (n_tb + K_BUY)

LightGBM burada BİLEREK yok: lig geneli ≥50 bin raunt eşiğine (§7.2)
ulaşıldığında evaluate.py düzeneğine aday model olarak eklenecek —
taban çizgiyi zamansal test setinde geçemeyen model API'ye çıkmaz (§6.2).

Zaman ağırlığı (recency.py): her satırın SON elemanı zaman-azalım ağırlığıdır
(1.0 = tam sayılır). Dağılımlar bu ağırlıkla toplanır; ham raunt sayısı
(n) yerine ağırlık toplamı (n_eff) büzülme paydasında kullanılır.
"""

from __future__ import annotations

from collections import Counter, defaultdict

K_TEAM = 20   # takım → lig büzülmesi (tendencies.SHRINK_K ile aynı)
K_BUY = 10    # takım+buy → takım büzülmesi

Row = tuple  # (map_name, side, team_id, buy_type, cluster_id, [opp_id], weight)


def league_dist(rows: list[Row], map_name: str, side: str) -> dict[int, float]:
    w: dict[int, float] = defaultdict(float)
    for r in rows:
        if r[0] == map_name and r[1] == side:
            w[r[4]] += r[-1]
    total = sum(w.values())
    return {k: v / total for k, v in w.items()} if total else {}


def team_dist(rows: list[Row], map_name: str, side: str, team_id) -> dict[int, float]:
    lig = league_dist(rows, map_name, side)
    w: dict[int, float] = defaultdict(float)
    for r in rows:
        if r[0] == map_name and r[1] == side and r[2] == team_id:
            w[r[4]] += r[-1]
    n = sum(w.values())
    return {
        k: (n * (w.get(k, 0.0) / n if n else 0.0) + K_TEAM * p) / (n + K_TEAM)
        for k, p in lig.items()
    }


def team_buy_dist(rows: list[Row], map_name: str, side: str, team_id, buy: str) -> dict[int, float]:
    base = team_dist(rows, map_name, side, team_id)
    w: dict[int, float] = defaultdict(float)
    for r in rows:
        if r[0] == map_name and r[1] == side and r[2] == team_id and r[3] == buy:
            w[r[4]] += r[-1]
    n = sum(w.values())
    return {
        k: (n * (w.get(k, 0.0) / n if n else 0.0) + K_BUY * p) / (n + K_BUY)
        for k, p in base.items()
    }


def counts_by_team_buy(rows: list[Row]) -> dict[tuple, Counter]:
    out: dict[tuple, Counter] = defaultdict(Counter)
    for row in rows:
        map_name, side, team_id, buy, cluster = row[:5]
        if buy is not None:
            out[(team_id, map_name, side, buy)][cluster] += 1
    return out


# ---- Rakip-özel kalibrasyon (B1) ---------------------------------------
# VsRow = (map_name, side, team_id, buy_type, cluster_id, opp_team_id)
# İki yeni katman; ikisi de takım dağılımının ÜSTÜNE büzülür:
#   team_vs    : yalnız bu rakibe karşı oynanan rauntlar (head-to-head).
#   team_style : rakip Y'ye "benzer savunan/hücum eden" rakiplere karşı
#                rauntlar, benzerlik ağırlığıyla havuzlanır. Benzerlik =
#                rakiplerin KARŞI taraftaki kendi küme profillerinin
#                kosinüs benzerliği (γ üssüyle keskinleştirilir).

K_VS = 12      # head-to-head → takım büzülmesi (az veri, temkinli)
K_STYLE = 25   # stil havuzu → takım büzülmesi
STYLE_GAMMA = 3.0  # benzerlik keskinliği (1=yumuşak, büyük=sadece çok benzeyenler)


def team_vs_dist(rows: list, map_name: str, side: str, team_id, opp_id) -> dict[int, float]:
    base = team_dist(rows, map_name, side, team_id)
    w: dict[int, float] = defaultdict(float)
    for r in rows:
        if (r[0] == map_name and r[1] == side and r[2] == team_id
                and len(r) > 6 and r[5] == opp_id):
            w[r[4]] += r[-1]
    n = sum(w.values())
    return {
        k: (n * (w.get(k, 0.0) / n if n else 0.0) + K_VS * p) / (n + K_VS)
        for k, p in base.items()
    }


def opponent_profiles(rows: list, map_name: str, side: str) -> dict:
    """Rakip profili: verilen tarafa KARŞI oynayan takımların, o karşı
    taraftaki kendi küme dağılımları. (T tahmini için CT'lerin profili.)
    Eşik (>=12) ham raunt sayısına bakar; dağılımın kendisi ağırlıklıdır."""
    other = "CT" if side == "T" else "T"
    raw_n: dict = defaultdict(int)
    wsum: dict = defaultdict(lambda: defaultdict(float))
    for r in rows:
        if r[0] == map_name and r[1] == other and r[2] is not None:
            raw_n[r[2]] += 1
            wsum[r[2]][r[4]] += r[-1]
    out = {}
    for team, c in wsum.items():
        if raw_n[team] < 12:  # çok az veriyle profil çıkmaz
            continue
        total = sum(c.values())
        if total:
            out[team] = {k: v / total for k, v in c.items()}
    return out


def _cosine(a: dict, b: dict) -> float:
    keys = set(a) | set(b)
    dot = sum(a.get(k, 0.0) * b.get(k, 0.0) for k in keys)
    na = sum(v * v for v in a.values()) ** 0.5
    nb = sum(v * v for v in b.values()) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def team_style_dist(rows: list, map_name: str, side: str, team_id, opp_id,
                    profiles: dict | None = None) -> dict[int, float]:
    base = team_dist(rows, map_name, side, team_id)
    profs = profiles if profiles is not None else opponent_profiles(rows, map_name, side)
    target = profs.get(opp_id)
    if not target:
        return base  # rakip profili yoksa dürüstçe takım dağılımı
    wsum: dict[int, float] = defaultdict(float)
    n_eff = 0.0
    for r in rows:
        if r[0] != map_name or r[1] != side or r[2] != team_id or len(r) < 7:
            continue
        prof = profs.get(r[5])
        if not prof:
            continue
        sim = _cosine(prof, target) ** STYLE_GAMMA
        if sim <= 0:
            continue
        w = sim * r[-1]  # benzerlik × zaman-ağırlığı
        wsum[r[4]] += w
        n_eff += w
    return {
        k: (n_eff * (wsum.get(k, 0.0) / n_eff if n_eff else 0.0) + K_STYLE * p) / (n_eff + K_STYLE)
        for k, p in base.items()
    }
