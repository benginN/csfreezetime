#!/usr/bin/env bash
# Platformu güvenle durdurur — SSD'yi çıkarmadan önce ZORUNLU adım:
# Colima VM'in diski SSD'de yaşar; çalışırken çekmek veritabanını bozabilir.
# Sıra: servis süreçleri → colima stop (konteynerler VM ile birlikte iner).
# İdempotent: zaten kapalıysa sorun çıkarmaz.
set -uo pipefail  # -e yok: pkill eşleşme bulamayınca 1 döner, bu normaldir

echo "→ servisler durduruluyor…"
pkill -f './services/stats-svc/stats-svc' 2>/dev/null || true
pkill -f 'enrichment-worker' 2>/dev/null || true
pkill -f 'parser-worker/target/release/parser-worker' 2>/dev/null || true
sleep 2

if colima status >/dev/null 2>&1; then
    echo "→ colima durduruluyor (postgres/clickhouse/minio/nats birlikte iner)…"
    colima stop
else
    echo "✓ colima zaten kapalı"
fi

echo
echo "✓ her şey durdu."
echo "  SSD'yi çıkarmak için: önce bu terminali/oturumu kapat, sonra Finder'dan ⏏."
echo "  Tekrar açmak için: scripts/start-all.sh"
