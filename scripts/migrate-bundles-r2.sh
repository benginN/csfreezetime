#!/usr/bin/env bash
# migrate-bundles-r2.sh — TEK SEFERLİK: GitHub Releases'taki replay
# paketlerini Cloudflare R2'ye taşır ve canlı manifesti R2'ye çevirir.
# Sebep (2026-07-12): GitHub Releases indirmeleri CORS başlığı taşımıyor,
# tarayıcı paketleri çekemiyor; R2 bedavaya yakın ve CORS ayarlanabilir.
#
# ÖN KOŞUL — infra/.env içine şunlar eklenmiş olmalı (Cloudflare → R2):
#   R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
#   R2_ACCESS_KEY_ID=…     R2_SECRET_ACCESS_KEY=…
#   R2_BUCKET=freezetime-bundles
#   R2_PUBLIC_BASE=https://pub-<hash>.r2.dev   (bucket'ın public URL'i)
# ve bucket'ta CORS izni (aşağıda otomatik denenir; olmazsa panelden:
#   AllowedOrigins: https://benginn.github.io — AllowedMethods: GET).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source infra/.env; set +a
: "${R2_ENDPOINT:?R2_ENDPOINT eksik}" "${R2_ACCESS_KEY_ID:?}" \
  "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}" "${R2_PUBLIC_BASE:?}"

SITE_REPO="${FREEZETIME_SITE_REPO:-benginN/benginN.github.io}"
WORK="$(pwd)/.publish/site"
# DİKKAT: Colima VM'i yalnız EV DİZİNİNİ paylaşır — /var/folders da
# /Volumes/T7 de konteynerden GÖRÜNMEZ (docker -v boş klasör bağlar).
# Geçici alan bu yüzden $HOME altında (2026-07-12 vakası, iki deneme).
TMP="$HOME/.freezetime-migrate-tmp"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

MC() { docker run --rm -v "$TMP":/work --entrypoint sh minio/mc -c \
  "mc alias set r2 '$R2_ENDPOINT' '$R2_ACCESS_KEY_ID' '$R2_SECRET_ACCESS_KEY' >/dev/null && $1"; }

echo "→ bucket + CORS hazırlanıyor…"
MC "mc mb --ignore-existing r2/$R2_BUCKET" || true
cat > "$TMP/cors.json" <<EOF
[{"AllowedOrigins":["https://benginn.github.io"],"AllowedMethods":["GET"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
EOF
MC "mc cors set r2/$R2_BUCKET /work/cors.json" \
  || echo "⚠ CORS otomatik ayarlanamadı — Cloudflare panelinden ekle (script devam ediyor)"

echo "→ Releases'tan indirilip R2'ye taşınıyor…"
gh release list -R "$SITE_REPO" --limit 200 --json tagName --jq '.[].tagName' | while read -r tag; do
  want=$(gh release view "$tag" -R "$SITE_REPO" --json assets --jq '.assets | length')
  have=$(MC "mc ls 'r2/$R2_BUCKET/$tag/' 2>/dev/null | wc -l" || echo 0); have=$(echo "$have" | tr -dc '0-9'); have=${have:-0}
  if [ "$have" -ge "$want" ] && [ "$want" -gt 0 ]; then
    echo "  ↷ $tag zaten R2'de ($have/$want) — atlandı"
    continue
  fi
  mkdir -p "$TMP/dl/$tag"
  gh release download "$tag" -R "$SITE_REPO" --pattern '*.json.gz' --dir "$TMP/dl/$tag"
  docker run --rm -v "$TMP/dl/$tag":/data:ro --entrypoint sh minio/mc -c \
    "mc alias set r2 '$R2_ENDPOINT' '$R2_ACCESS_KEY_ID' '$R2_SECRET_ACCESS_KEY' >/dev/null && \
     mc cp --recursive /data/ 'r2/$R2_BUCKET/$tag/'"
  rm -rf "$TMP/dl/$tag"
  echo "  ✓ $tag ($want paket)"
done

echo "→ manifest R2'ye çevriliyor…"
python3 - "$WORK/data/manifest.json" "$R2_PUBLIC_BASE" <<'PY'
import json, sys
p, base = sys.argv[1], sys.argv[2].rstrip('/')
m = json.load(open(p))
m['bundle_base'] = base
json.dump(m, open(p, 'w'), indent=1)
PY

git -C "$WORK" add data/manifest.json
git -C "$WORK" commit -q -m "serve bundles from R2 (GitHub Releases lack CORS)"
git -C "$WORK" push -q origin HEAD

echo "→ doğrulama…"
url="$R2_PUBLIC_BASE/$(python3 -c "
import json; m=json.load(open('$WORK/data/manifest.json'))
v=sorted(m['matches'].values(), key=lambda x:x['file'])[0]
print(v['tag']+'/'+v['file'])")"
code=$(curl -sfL -H "Origin: https://benginn.github.io" -D - -o /dev/null "$url" | tr -d '\r' | awk 'BEGIN{c="?";a="YOK"} /^HTTP/{c=$2} tolower($0)~/^access-control-allow-origin/{a=$2} END{print c" ACAO:"a}')
echo "  örnek paket: $code"
echo "✔ R2 göçü tamam — Releases yedek olarak durmaya devam ediyor."
