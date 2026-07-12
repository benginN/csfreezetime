#!/usr/bin/env bash
# publish.sh — stüdyodan statik siteye fark bazlı yayın (Faz Y, mimari §11.1).
#
#   scripts/publish.sh            # yeni maçları paketle + siteyi yayınla
#   scripts/publish.sh --pages-only  # paket üretme, yalnız sayfa JSON + site
#
# Akış: çalışan stats-svc'den export → paketler GitHub Releases'a →
# site (frontend build + data/) kök Pages reposuna push. İlk kullanımdan
# önce bir kez: site reposunu oluştur ve Settings→Pages→main branşını aç.
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_REPO="${FREEZETIME_SITE_REPO:-benginN/benginN.github.io}"
API="${FREEZETIME_API:-http://localhost:8090}"
# MUTLAK yol şart: exporter services/stats-svc içinden koşuyor — göreli
# WORK oraya çözülüp paketleri yanlış klasöre yazıyordu (2026-07-12 vakası)
WORK="$(pwd)/.publish/site"
BUNDLE_BASE="https://github.com/${SITE_REPO}/releases/download"
# R2 modu (2026-07-12 CORS pivotu): GitHub Releases indirmeleri CORS başlığı
# taşımıyor → tarayıcı paketleri çekemiyor. infra/.env'de R2_* dolu ise
# paketler Cloudflare R2'ye gider ve manifest R2 URL'leri yazar.
# Gerekli env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
#              R2_BUCKET, R2_PUBLIC_BASE (pub-….r2.dev veya özel domain)
if [ -n "${R2_PUBLIC_BASE:-}" ]; then
  BUNDLE_BASE="$R2_PUBLIC_BASE"
fi
r2_upload_dir() { # $1 = yerel dizin, $2 = hedef önek (turnuva tag'i)
  docker run --rm -v "$1":/data:ro --entrypoint sh minio/mc -c \
    "mc alias set r2 '$R2_ENDPOINT' '$R2_ACCESS_KEY_ID' '$R2_SECRET_ACCESS_KEY' >/dev/null && \
     mc cp --recursive /data/ 'r2/$R2_BUCKET/$2/'"
}

command -v gh >/dev/null || { echo "gh CLI gerekli (brew install gh)"; exit 1; }
curl -sf "${API}/api/v1/teams" >/dev/null || { echo "stats-svc yanıt vermiyor (${API}) — stüdyoyu başlat"; exit 1; }

# --- site reposu çalışma kopyası -------------------------------------------
if [ ! -d "$WORK/.git" ]; then
  mkdir -p .publish
  gh repo clone "$SITE_REPO" "$WORK" || {
    echo "site reposu yok — oluşturuluyor: $SITE_REPO"
    gh repo create "$SITE_REPO" --public --description "Freezetime — CS2 tactical archive (static site)"
    gh repo clone "$SITE_REPO" "$WORK"
  }
fi
git -C "$WORK" pull --ff-only 2>/dev/null || true

# bundles-new asla git'e girmez (Releases'a gider) — .gitignore garanti
grep -qs '^bundles-new/$' "$WORK/.gitignore" 2>/dev/null || printf 'bundles-new/\n' >> "$WORK/.gitignore"

# Boş repoya GitHub Release açılamaz (422) — ilk commit'i garanti et.
# DİKKAT: add -A DEĞİL — export çıktıları (12GB paket) staging'de olabilir
if ! git -C "$WORK" rev-parse HEAD >/dev/null 2>&1; then
  touch "$WORK/.nojekyll"
  git -C "$WORK" add .nojekyll .gitignore
  git -C "$WORK" commit -q -m "init site"
  git -C "$WORK" push -q origin HEAD
fi

# --- export -----------------------------------------------------------------
EXPORT_FLAGS=(-api "$API" -out "$WORK" -bundle-base "$BUNDLE_BASE")
[ "${1:-}" = "--pages-only" ] && EXPORT_FLAGS+=(-skip-bundles)
(cd services/stats-svc && go run ./cmd/export "${EXPORT_FLAGS[@]}")

# --- yeni paketleri yükle: R2 (varsa) yoksa GitHub Releases ---------------
# (manifest URL'leri canlanmadan site push edilmez; başarısız yükleme =
#  script durur, manifest push edilmez)
if [ -d "$WORK/bundles-new" ]; then
  for dir in "$WORK"/bundles-new/*/; do
    [ -d "$dir" ] || continue
    tag="$(basename "$dir")"
    if [ -n "${R2_PUBLIC_BASE:-}" ]; then
      r2_upload_dir "$dir" "$tag"
    else
      if ! gh release view "$tag" -R "$SITE_REPO" >/dev/null 2>&1; then
        gh release create "$tag" -R "$SITE_REPO" --title "$tag" \
          --notes "match replay bundles (auto-published)"
      fi
      find "$dir" -name '*.json.gz' -print0 | xargs -0 -n 50 \
        gh release upload "$tag" -R "$SITE_REPO" --clobber
    fi
    rm -rf "$dir"
    echo "uploaded bundles: $tag"
  done
  rmdir "$WORK/bundles-new" 2>/dev/null || true
fi

# --- frontend (statik mod) ---------------------------------------------------
(cd apps/web && VITE_STATIC=1 npm run build)

# dist → site kökü (data/ ve .git korunur; eski asset'ler temizlenir)
rsync -a --delete \
  --exclude '.git' --exclude 'data' --exclude 'bundles-new' \
  --exclude 'CNAME' --exclude 'README.md' \
  apps/web/dist/ "$WORK/"
# radar görselleri stüdyoda stats-svc'den servis edilir; statikte siteye girer
rsync -a services/stats-svc/static/radars/ "$WORK/radars/"
# SPA deep-link'leri: Pages 404'ü uygulamaya düşürür; Jekyll kapalı
cp "$WORK/index.html" "$WORK/404.html"
touch "$WORK/.nojekyll"

# --- push ---------------------------------------------------------------------
matches=$(python3 -c "import json;print(len(json.load(open('$WORK/data/manifest.json'))['matches']))" 2>/dev/null || echo '?')
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "değişiklik yok — push atlanıyor"
else
  git -C "$WORK" commit -m "publish $(date -u +%Y-%m-%dT%H:%MZ) (${matches} matches)"
  git -C "$WORK" push origin HEAD
fi
echo "✔ publish tamam — ${matches} maç manifestte"
