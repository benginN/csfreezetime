#!/usr/bin/env bash
# Tüm platformu tek komutla ayağa kaldırır (moladan dönüş komutu):
#   Colima VM → docker compose altyapısı → parser ×2 + enrichment + stats-svc
# İdempotent: zaten ayakta olan adımlar atlanır. Loglar /tmp altına yazılır.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 1. Colima (VM diski SSD'de — SSD takılı olmalı)
if ! colima status >/dev/null 2>&1; then
    echo "→ colima başlatılıyor…"
    colima start --cpu 4 --memory 8
else
    echo "✓ colima ayakta"
fi

# 2. Altyapı konteynerleri (up --wait one-shot minio-init yüzünden 1 döner;
#    kalıcı dört servis aşağıda açıkça beklenir)
echo "→ docker compose up…"
docker compose -f infra/docker-compose.yml up -d >/dev/null 2>&1 || true
for svc in postgres clickhouse minio nats; do
    until docker compose -f infra/docker-compose.yml ps "$svc" --format '{{.Status}}' | grep -q healthy; do
        sleep 2
    done
    echo "✓ $svc sağlıklı"
done

# 3. Servis süreçleri (varsa dokunma, yoksa başlat)
set -a; source infra/.env; set +a

# macOS pgrep'te -c yok → wc -l; BSD seq azalan da sayar → önce koşulla ele;
# eşleşme yoksa pgrep 1 döner → pipefail'i tetiklemesin diye || true
NPARSER=$( (pgrep -f 'parser-worker/target/release/parser-worker' 2>/dev/null || true) | wc -l | tr -d ' ')
if [ "$NPARSER" -ge 2 ]; then
    echo "✓ parser ×2 zaten çalışıyor"
else
    for i in $(seq $((NPARSER + 1)) 2); do
        echo "→ parser-$i başlatılıyor…"
        nohup ./services/parser-worker/target/release/parser-worker >"/tmp/parser-$i.log" 2>&1 &
    done
fi

if pgrep -f 'enrichment-worker' >/dev/null 2>&1; then
    echo "✓ enrichment zaten çalışıyor"
else
    echo "→ enrichment başlatılıyor…"
    (cd services/enrichment && nohup uv run --no-editable enrichment-worker >/tmp/enrichment.log 2>&1 &)
fi

if pgrep -f './services/stats-svc/stats-svc' >/dev/null 2>&1; then
    echo "✓ stats-svc zaten çalışıyor"
else
    echo "→ stats-svc başlatılıyor…"
    nohup ./services/stats-svc/stats-svc >/tmp/stats-svc.log 2>&1 &
fi

sleep 3
echo
echo "— durum —"
curl -s -o /dev/null -w "stats-svc API: %{http_code}\n" http://localhost:8090/api/v1/teams || true
echo "hazır. backfill/ klasörüne demo atabilirsin; retention ve ml-auto kendiliğinden çalışır."
