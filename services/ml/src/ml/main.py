"""ml-jobs: tüm yerel istatistik işlerini sırayla çalıştırır.

Kullanım: (env yüklü) uv run ml-jobs
Demo eklendikçe yeniden çalıştırılır; tamamen deterministik (seed sabit),
dış servis çağrısı yoktur.
"""

from __future__ import annotations

import time

from . import anomaly, clustering, db, features, tendencies


def cli() -> None:
    t0 = time.time()
    pgconn = db.pg()
    chc = db.ch()

    # kümelenecek (harita, taraf) çiftleri
    with pgconn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT map_name FROM matches WHERE status = 'ready' AND map_name IS NOT NULL"
        )
        maps = [r[0] for r in cur.fetchall()]

    print("— strateji kümeleme —")
    for m in sorted(maps):
        for side in ("T", "CT"):
            fs = features.extract(chc, pgconn, m, side)
            if fs is None:
                print(f"  {m}/{side}: veri yetersiz, atlandı")
                continue
            res = clustering.run(pgconn, fs)
            if res is None:
                print(f"  {m}/{side}: {len(fs.keys)} raunt < eşik, atlandı")
            else:
                print(f"  {m}/{side}: {res['rounds']} raunt → {res['k']} küme")

    print("— takım eğilimleri —")
    n = tendencies.run(pgconn)
    print(f"  {n} eğilim satırı (büzülme k={tendencies.SHRINK_K})")

    print("— anomali bayrakları —")
    f = anomaly.run(pgconn)
    print(f"  {f} bayrak (|z| > {anomaly.Z_THRESHOLD})")

    print(f"tamam ({time.time() - t0:.1f} sn)")


if __name__ == "__main__":
    cli()
