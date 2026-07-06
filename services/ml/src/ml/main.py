"""ml-jobs: tüm yerel istatistik işlerini sırayla çalıştırır.

Kullanım: (env yüklü) uv run ml-jobs
Demo eklendikçe yeniden çalıştırılır; tamamen deterministik (seed sabit),
dış servis çağrısı yoktur.
"""

from __future__ import annotations

import time

from . import (
    anomaly, clustering, clutch, db, evaluate, features, flashstats,
    aliases, integrity, roles, rotations, setups, templates, tendencies, tournaments, utility, winprob,
)


def cli() -> None:
    t0 = time.time()
    pgconn = db.pg()
    # süreçler arası kilit: manuel koşu + ml-auto çakışması tablo yazımlarını
    # yarıştırıp çift anahtar üretebilir; ikinci süreç sessizce çekilir.
    with pgconn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(834729)")
        if not cur.fetchone()[0]:
            print("ml-jobs zaten çalışıyor (kilit dolu) — bu koşu atlandı")
            return
    chc = db.ch()

    # kümelenecek (harita, taraf) çiftleri
    with pgconn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT map_name FROM matches WHERE status = 'ready' AND map_name IS NOT NULL"
        )
        maps = [r[0] for r in cur.fetchall()]

    n_alias = aliases.run(pgconn)
    if n_alias:
        print(f"— takım birleştirme: {n_alias} alias kanonikleştirildi —")
    n_fix = integrity.run(pgconn)
    if n_fix:
        print(f"— bütünlük: {n_fix} raunt etiketi onarıldı —")
    n_t = tournaments.run(pgconn)
    print(f"— turnuva etiketleri: {n_t} maç rafine edildi —")

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

    print("— rakip-kalibre eğilimler (vs + style) —")
    nv = evaluate.write_vs(pgconn)
    print(f"  {nv} rakip-kalibre satır")

    print("— tahmin değerlendirmesi (zamansal, log-loss; düşük iyi) —")
    print(f"  {'harita/taraf':<16} {'lig':>7} {'takım':>7} {'t+buy':>7} "
          f"{'t+vs':>7} {'t+stil':>7}  kazanan (n_test)")
    for r in evaluate.run(pgconn):
        print(f"  {r['map'] + '/' + r['side']:<16} {r['league']:>7.3f} "
              f"{r['team']:>7.3f} {r['team_buy']:>7.3f} {r['team_vs']:>7.3f} "
              f"{r['team_style']:>7.3f}  {r['best']} ({r['n_test']})")

    print("— utility istihbaratı —")
    nu = utility.run(pgconn, chc)
    print(f"  {nu} utility kümesi (n≥{utility.MIN_COUNT})")

    n_tpl = templates.run(pgconn)
    print(f"— execute şablonları: {n_tpl} desen —")

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
