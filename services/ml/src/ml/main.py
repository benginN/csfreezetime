"""ml-jobs: tüm yerel istatistik işlerini sırayla çalıştırır.

Kullanım: (env yüklü) uv run ml-jobs
Demo eklendikçe yeniden çalıştırılır; tamamen deterministik (seed sabit),
dış servis çağrısı yoktur.
"""

from __future__ import annotations

import time

from . import (
    anomaly, clustering, clutch, db, evaluate, features, flashstats,
    roles, rotations, setups, tendencies, utility, winprob,
)


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

    print("— koşullu eğilimler (takım+buy) —")
    nc = evaluate.write_conditional(pgconn)
    print(f"  {nc} koşullu satır")

    print("— tahmin değerlendirmesi (zamansal, log-loss; düşük iyi) —")
    print(f"  {'harita/taraf':<16} {'lig':>7} {'takım':>7} {'t+buy':>7}  kazanan (n_test)")
    for r in evaluate.run(pgconn):
        print(f"  {r['map'] + '/' + r['side']:<16} {r['league']:>7.3f} "
              f"{r['team']:>7.3f} {r['team_buy']:>7.3f}  {r['best']} ({r['n_test']})")

    print("— utility istihbaratı —")
    nu = utility.run(pgconn, chc)
    print(f"  {nu} utility kümesi (n≥{utility.MIN_COUNT})")

    print("— kurulum (default) tespiti —")
    ns = setups.run(pgconn, chc)
    print(f"  {ns} kurulum deseni (t={list(setups.OFFSETS)} sn)")

    print("— rotasyon analizi (temas sonrası) —")
    nrot = rotations.run(pgconn, chc)
    print(f"  {nrot} pozisyon-rotasyon satırı (pencere {rotations.ROT_WINDOW} sn, n≥{rotations.MIN_CONTACTS})")

    print("— oyuncu rolleri —")
    nr = roles.run(pgconn, chc)
    print(f"  {nr} oyuncu-taraf profili (etiket eşiği {roles.MIN_ROUNDS} raunt)")

    print("— flash etkinliği (flash_remaining sıçramalarından) —")
    nf, nm = flashstats.run(pgconn, chc)
    print(f"  {nf} flash'a {nm} körlük atandı")

    print("— kazanma olasılığı tablosu + raunt zirveleri —")
    nc_, np_ = winprob.run(pgconn, chc)
    print(f"  {nc_} durum hücresi, {np_} raunt zirvesi (büzülme k={winprob.SHRINK_K})")

    print("— clutch tespiti (1vX) —")
    ncl = clutch.run(pgconn, chc)
    print(f"  {ncl} clutch durumu")

    print("— anomali bayrakları —")
    f = anomaly.run(pgconn)
    print(f"  {f} bayrak (|z| > {anomaly.Z_THRESHOLD})")

    print(f"tamam ({time.time() - t0:.1f} sn)")


if __name__ == "__main__":
    cli()
