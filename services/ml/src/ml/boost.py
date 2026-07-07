"""LightGBM aday modeli (§6.2, Faz D): strateji dağılımı tahmini.

Her (harita, taraf) çifti için ayrı çok-sınıflı LightGBM eğitilir
(küme etiketleri harita+taraf başına tanımlı olduğundan tek ortak model
kurulamaz). Bilgi seti team_buy taban çizgisiyle AYNI granülaritede
tutulur — takım kimliği yerine takımın recency-ağırlıklı geçmiş küme
payları + buy tipi + kanıt gücü (n_eff). Modelin kazanma şansı ham
bilgi avantajından değil, takımlar-ARASI genellemeden gelir: benzer
stil parmak izine sahip takımları ağaçlar kendiliğinden havuzlar
(team_style'ın el yapımı benzerlik havuzunun öğrenilmiş hâli).

Dürüstlük kuralları evaluate.py ile aynıdır: zamansal bölünmede
team_buy'ı geçemeyen (harita, taraf) çiftinde model SUNULMAZ; eğitim
özellikleri yalnız eğitim rauntlarından türetilir (sızıntı yok).
Satır biçimi evaluate._fetch_rounds ile aynı 9'lu demettir.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict

import numpy as np

from . import recency

EPS = 1e-9
MIN_TRAIN = 200      # bu kadar eğitim raundu yoksa çift atlanır (inf döner)
BUYS = ("pistol", "eco", "force", "semi", "full")
_BUY_CODE = {b: i for i, b in enumerate(BUYS)}

_PARAMS = dict(
    objective="multiclass",
    learning_rate=0.05,
    num_leaves=15,
    min_child_samples=25,
    feature_fraction=0.9,
    bagging_fraction=0.9,
    bagging_freq=1,
    seed=42,
    deterministic=True,
    force_row_wise=True,
    verbosity=-1,
)
_ROUNDS = 150


def _team_shares(rows: list[tuple], clusters: list[int], ref) -> dict:
    """takım → (recency-ağırlıklı küme pay vektörü, n_eff).

    rows: evaluate._fetch_rounds 9'lu demetleri (tek harita+taraf).
    """
    w: dict = defaultdict(lambda: defaultdict(float))
    for r in rows:
        w[r[2]][r[4]] += recency.weight(r[8], ref)
    out = {}
    for team, counts in w.items():
        n_eff = sum(counts.values())
        vec = [counts.get(c, 0.0) / n_eff if n_eff else 0.0 for c in clusters]
        out[team] = (vec, n_eff)
    return out


def _matrix(rows: list[tuple], shares: dict, clusters: list[int], k: int):
    """X, y, sample_weight üret. Bilinmeyen takım → sıfır vektör, n_eff=0."""
    zero = ([0.0] * len(clusters), 0.0)
    X, y, sw = [], [], []
    cindex = {c: i for i, c in enumerate(clusters)}
    for r in rows:
        vec, n_eff = shares.get(r[2], zero)
        buy = _BUY_CODE.get(r[3], len(BUYS))  # bilinmeyen buy = ayrı kod
        X.append([buy, math.log1p(n_eff), *vec])
        y.append(cindex.get(r[4], -1))
        sw.append(1.0)
    return np.asarray(X, dtype=np.float64), np.asarray(y), np.asarray(sw)


def evaluate_pair(train: list[tuple], test: list[tuple], ref) -> float:
    """Tek (harita, taraf) çifti için zamansal log-loss (düşük iyi).

    train/test: evaluate._split çıktısının o çifte süzülmüş satırları.
    Eğitim payları ve model YALNIZ train'den; test yalnız skorlanır.
    """
    if len(train) < MIN_TRAIN:
        return float("inf")
    clusters = sorted({r[4] for r in train})
    if len(clusters) < 2:
        return float("inf")
    import lightgbm as lgb  # ağır import; yalnız gerekince

    shares = _team_shares(train, clusters, ref)
    Xtr, ytr, _ = _matrix(train, shares, clusters, len(clusters))
    # örnek ağırlığı = zaman azalımı (eğitimde model de aynı ilkeye uysun)
    swtr = np.asarray([recency.weight(r[8], ref) for r in train])
    ds = lgb.Dataset(Xtr, label=ytr, weight=swtr,
                     categorical_feature=[0], free_raw_data=True)
    booster = lgb.train({**_PARAMS, "num_class": len(clusters)}, ds,
                        num_boost_round=_ROUNDS)

    Xte, yte, _ = _matrix(test, shares, clusters, len(clusters))
    proba = booster.predict(Xte)
    total = 0.0
    for i, cls in enumerate(yte):
        p = proba[i][cls] if cls >= 0 else 0.0  # eğitimde görülmemiş küme
        total += -math.log(max(p, EPS))
    return total / len(yte) if len(yte) else float("inf")


def train_full(rows: list[tuple], map_name: str, side: str, ref):
    """Sunum için TÜM veriyle eğitim: (booster, clusters, shares) veya None."""
    grp = [r for r in rows if r[0] == map_name and r[1] == side]
    if len(grp) < MIN_TRAIN:
        return None
    clusters = sorted({r[4] for r in grp})
    if len(clusters) < 2:
        return None
    import lightgbm as lgb

    shares = _team_shares(grp, clusters, ref)
    X, y, _ = _matrix(grp, shares, clusters, len(clusters))
    sw = np.asarray([recency.weight(r[8], ref) for r in grp])
    ds = lgb.Dataset(X, label=y, weight=sw,
                     categorical_feature=[0], free_raw_data=True)
    booster = lgb.train({**_PARAMS, "num_class": len(clusters)}, ds,
                        num_boost_round=_ROUNDS)
    return booster, clusters, shares


FEATURE_NAMES = ["buy_type", "log_n_eff"]  # + cluster_share_<id>...


def importances(booster, clusters: list[int]) -> dict[str, float]:
    """Özellik önemleri (gain) — ML Lab şeffaflık paneli için."""
    names = FEATURE_NAMES + [f"own_share_c{c}" for c in clusters]
    gains = booster.feature_importance(importance_type="gain")
    total = float(sum(gains)) or 1.0
    return {n: round(float(g) / total, 4) for n, g in zip(names, gains)}


def write_predictions(pgconn, ref) -> int:
    """lgbm_predictions sunum tablosu: (takım, harita, taraf, buy) → dağılım.

    Yalnız prediction_meta'da lgbm'in KAZANDIĞI (harita, taraf) çiftleri
    yazılır — kaybettiği yerde tablo boş kalır ve API dürüstçe büzülme
    zincirine düşer. Önemler prediction_meta.lgbm_importance'a gider.
    """
    from . import evaluate  # döngüsel importu koşu anına ertele

    rows = evaluate._fetch_rounds(pgconn)
    with pgconn.cursor() as cur:
        cur.execute("SELECT map_name, side FROM prediction_meta WHERE best_method = 'lgbm'")
        winners = cur.fetchall()
    inserted = 0
    with pgconn.cursor() as cur:
        cur.execute("DELETE FROM lgbm_predictions")
        for map_name, side in winners:
            model = train_full(rows, map_name, side, ref)
            if model is None:
                continue
            booster, clusters, shares = model
            cur.execute(
                "UPDATE prediction_meta SET lgbm_importance = %s WHERE map_name = %s AND side = %s",
                (json.dumps(importances(booster, clusters)), map_name, side),
            )
            for team, (vec, n_eff) in shares.items():
                for buy in BUYS:
                    X = np.asarray([[_BUY_CODE[buy], math.log1p(n_eff), *vec]])
                    proba = booster.predict(X)[0]
                    for c, p in zip(clusters, proba):
                        cur.execute(
                            """
                            INSERT INTO lgbm_predictions
                                (team_id, map_name, side, buy_type, cluster_id, prob, n_eff)
                            VALUES (%s, %s, %s, %s, %s, %s, %s)
                            """,
                            (team, map_name, side, buy, c, float(p), n_eff),
                        )
                        inserted += 1
    pgconn.commit()
    return inserted
