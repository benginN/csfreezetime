"""Strateji kümeleme (mimari.md §6.2 Aşama 1): harita+taraf başına k-means.

k, silhouette skoruyla seçilir; küme kimlikleri rounds.t/ct_strategy_cluster'a,
küme özetleri strategy_clusters tablosuna yazılır. Koç isimlendirmesi (label)
insan döngüde — burada NULL bırakılır, mevcut etiketler korunur.
"""

from __future__ import annotations

import json

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

from .features import FeatureSet, WINDOWS

MIN_ROUNDS = 12          # altında kümeleme anlamsız
SEED = 42                # deterministik


def choose_k(X: np.ndarray) -> int:
    n = len(X)
    if n < 30:
        return 3
    best_k, best_s = 3, -1.0
    for k in range(3, min(8, n // 8) + 1):
        km = KMeans(n_clusters=k, n_init=10, random_state=SEED).fit(X)
        s = silhouette_score(X, km.labels_)
        if s > best_s:
            best_k, best_s = k, s
    return best_k


def run(pgconn, fs: FeatureSet) -> dict | None:
    if len(fs.keys) < MIN_ROUNDS:
        return None
    k = choose_k(fs.X)
    km = KMeans(n_clusters=k, n_init=10, random_state=SEED).fit(fs.X)
    labels = km.labels_

    col = "t_strategy_cluster" if fs.side == "T" else "ct_strategy_cluster"
    P = len(fs.places)
    with pgconn.cursor() as cur:
        # raunt kimlikleri
        for (mid, rn), lbl in zip(fs.keys, labels):
            cur.execute(
                f"UPDATE rounds SET {col} = %s WHERE match_id = %s AND round_number = %s",
                (int(lbl), mid, rn),
            )
        # küme özetleri (mevcut label korunur)
        cur.execute(
            "SELECT cluster_id, label FROM strategy_clusters WHERE map_name = %s AND side = %s",
            (fs.map_name, fs.side),
        )
        old_labels = dict(cur.fetchall())
        cur.execute(
            "DELETE FROM strategy_clusters WHERE map_name = %s AND side = %s",
            (fs.map_name, fs.side),
        )
        for c in range(k):
            mask = labels == c
            center = km.cluster_centers_[c]
            # merkezin bölge profili: pencereler ortalaması → en belirgin 5 bölge.
            # Spawn bölgeleri elenir: her raunt orada başladığından her rotada
            # baskın çıkıp adları anlamsızlaştırıyordu ("TSpawn → A" vakası) —
            # kümeyi AYIRAN bölgeler spawn sonrası gidilen yerlerdir.
            occ = center[: WINDOWS * P].reshape(WINDOWS, P).mean(axis=0)
            top = sorted(
                ((pl, w) for pl, w in zip(fs.places, occ) if 'spawn' not in pl.lower()),
                key=lambda t: -t[1],
            )[:5]
            top_places = [{"place": p, "weight": round(float(w), 3)} for p, w in top if w > 0.02]
            # temsilciler: merkeze en yakın 3 raunt
            d = np.linalg.norm(fs.X[mask] - center, axis=1)
            reps_idx = np.array(fs.keys, dtype=object)[mask][np.argsort(d)[:3]]
            reps = [{"match_id": m, "round_number": int(r)} for m, r in reps_idx]
            cur.execute(
                """
                INSERT INTO strategy_clusters
                    (map_name, side, cluster_id, label, size, top_places, representatives)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (fs.map_name, fs.side, c, old_labels.get(c),
                 int(mask.sum()), json.dumps(top_places), json.dumps(reps)),
            )
    pgconn.commit()
    return {"map": fs.map_name, "side": fs.side, "rounds": len(fs.keys), "k": k}
