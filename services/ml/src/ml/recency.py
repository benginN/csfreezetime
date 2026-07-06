"""Zaman-azalımlı ağırlık: eski maçlar yeni maçlardan daha az sayılır.

Referans, arşivdeki EN SON maçın played_at'idir (duvar saati değil) — proje
molaya girip yeni demo eklenmese bile ağırlıklar oturumdan oturuma sabit
kalır. Tarihi bilinmeyen (played_at IS NULL) maçlar en yeni kabul edilir
(weight=1.0) — eksik tarih bir maçı haksız yere silikleştirmesin.

Ham gözlem sayıları (observed/sample_size/n/count) eşik kontrolleri için
HER ZAMAN ağırlıksız kalır; yalnız pay/olasılık/sıralama alanları
(share/shrunk_prob/prob) bu ağırlıkla hesaplanır.
"""

from __future__ import annotations

import datetime as dt

HALF_LIFE_DAYS = 90.0


def reference_date(pgconn) -> dt.datetime | None:
    with pgconn.cursor() as cur:
        cur.execute("SELECT max(played_at) FROM matches WHERE status = 'ready'")
        row = cur.fetchone()
        return row[0] if row else None


def weight(played_at: dt.datetime | None, reference: dt.datetime | None) -> float:
    if played_at is None or reference is None:
        return 1.0
    days = (reference - played_at).total_seconds() / 86400.0
    if days < 0:
        days = 0.0
    return 0.5 ** (days / HALF_LIFE_DAYS)
