#!/usr/bin/env bash
# weekly.sh — haftalık rutin, TEK KOMUT (mimari §11.1 "kur-unut" düzeni):
#   1. platformu kaldırır (start-all)
#   2. demoları backfill/ klasörüne atmanı bekler (ENTER ile onaylarsın)
#   3. işlenip durulmasını ve istatistiklerin tazelenmesini bekler
#   4. GitHub'a yayınlar (publish.sh — yalnız yeni maçlar)
#   5. sağlık kontrolü basar (site canlı mı, paket iniyor mu, ML tazel mi)
#   6. `weekly.sh --shutdown` dendiyse her şeyi kapatır (SSD çıkarılabilir)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SITE_URL="${FREEZETIME_SITE_URL:-https://benginN.github.io}"

./scripts/start-all.sh
set -a; source infra/.env; set +a
PSQL() { docker compose -f infra/docker-compose.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>/dev/null; }

ready0=$(PSQL "SELECT count(*) FROM matches WHERE status='ready'")
failed0=$(PSQL "SELECT count(*) FROM matches WHERE status='failed'")
tend0=$(PSQL "SELECT count(*) FROM team_tendencies")

echo
echo "🟢 Platform hazır (arşivde $ready0 maç)."
echo "   Haftanın demolarını şuraya at:  $ROOT/backfill/"
echo "   (istersen önce indirmelerin bitmesini bekle — yarım dosya atma!)"
read -r -p "   Atma işin bitince ENTER'a bas, gerisini ben hallederim… " _

echo "⏳ İşleniyor — kuyruk boşalıp sistem durulunca yayına geçilecek."
quiet=0; last_cur=""; stuck_n=0
while [ "$quiet" -lt 3 ]; do
  sleep 60
  pend=$(ls backfill/ 2>/dev/null | grep -ciE '\.(rar|zip|dem|gz|zst)$'); pend=${pend:-0}
  inflight=$(PSQL "SELECT count(*) FROM matches WHERE status NOT IN ('ready','failed','private')"); inflight=${inflight:-0}
  cur=$(curl -s --max-time 8 http://localhost:8090/api/v1/backfill/status \
        -H "X-Admin-Token: $ADMIN_TOKEN" | python3 -c \
        "import json,sys;print(json.load(sys.stdin).get('current') or '')" 2>/dev/null)
  # takılı dosya dedektörü: aynı dosya ~10 dk'dır "current" ise muhtemelen
  # bozuk/yarım inmiş arşiv (bkz. 2026-07-12 PGL Cluj vakası)
  if [ -n "$cur" ] && [ "$cur" = "$last_cur" ]; then stuck_n=$((stuck_n+1)); else stuck_n=0; fi
  last_cur="$cur"
  if [ "$stuck_n" -eq 10 ]; then
    echo "⚠️  '$cur' 10 dakikadır işleniyor — bozuk/yarım inmiş rar olabilir."
    echo "    Çözüm: dosyayı backfill/ dışına taşı (ör. ../corrupt-redownload/),"
    echo "    HLTV'den yeniden indir; script kaldığı yerden devam eder."
  fi
  if [ "$pend" -eq 0 ] && [ "$inflight" -eq 0 ] && [ -z "$cur" ]; then
    quiet=$((quiet+1))
  else
    quiet=0
  fi
done

echo "🟡 Kuyruk boş — istatistik tazelenmesi (ml-auto) bekleniyor…"
sleep 240
for _ in 1 2 3 4 5 6 7 8 9 10; do
  lock=$(PSQL "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=834729")
  [ "${lock:-0}" -eq 0 ] && break
  sleep 60
done

./scripts/publish.sh

echo
echo "—— SAĞLIK KONTROLÜ ——"
ready1=$(PSQL "SELECT count(*) FROM matches WHERE status='ready'")
failed1=$(PSQL "SELECT count(*) FROM matches WHERE status='failed'")
tend1=$(PSQL "SELECT count(*) FROM team_tendencies")
echo "1. Maç: +$((ready1-ready0)) yeni (toplam $ready1) · failed: $failed0 → $failed1"
live=$(curl -sf --max-time 20 "$SITE_URL/data/api/matches.json" \
       | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "ERİŞİLEMEDİ")
echo "2. Canlı site maç listesi: $live  ($SITE_URL)"
url=$(python3 -c "
import json; m = json.load(open('$ROOT/.publish/site/data/manifest.json'))
k, v = sorted(m['matches'].items())[-1]
print(m['bundle_base'] + '/' + v['tag'] + '/' + v['file'])" 2>/dev/null)
code=$(curl -sfL --max-time 60 -o /tmp/hc-bundle.gz -w '%{http_code}' "$url" 2>/dev/null || echo 000)
gunzip -t /tmp/hc-bundle.gz 2>/dev/null && bs="sağlam" || bs="BOZUK/İNEMEDİ"
echo "3. Örnek replay paketi: HTTP $code, içerik $bs"
echo "4. ML tazeliği: tendencies $tend0 → $tend1"
echo "5. Disk: T7 $(df -h /Volumes/T7 | tail -1 | awk '{print $5}') dolu · VM $(du -sh /Volumes/T7/cs2-freezetime/colima 2>/dev/null | awk '{print $1}')"

if [ "${1:-}" = "--shutdown" ]; then
  ./scripts/stop-all.sh
  echo "✔ her şey kapatıldı — SSD güvenle çıkarılabilir."
fi
echo "✅ haftalık rutin tamam."
