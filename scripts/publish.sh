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
# .env'i KENDİSİ yükler — weekly.sh'tan bağımsız koşulduğunda R2 ayarlarının
# görünmemesi paketleri yanlışlıkla Releases'a gönderiyordu (2026-07-12)
set -a; source infra/.env 2>/dev/null || true; set +a

SITE_REPO="${FREEZETIME_SITE_REPO:-benginN/csfreezetime}"
SITE_BRANCH="${FREEZETIME_SITE_BRANCH:-gh-pages}"
API="${FREEZETIME_API:-http://localhost:8090}"
# taban yol: kullanıcı sitesi (*.github.io) kökten, proje sitesi /<repo>/ altından yayınlanır
case "$SITE_REPO" in
  */*.github.io) VITE_BASE="/" ;;
  *)             VITE_BASE="/$(basename "$SITE_REPO")/" ;;
esac
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
# host mc kullanılır (brew install minio-mc) — docker -v Colima'da yalnız
# $HOME'u görür, T7 yolları konteynerde BOŞ görünür (2026-07-12 dersi)
r2_upload_dir() { # $1 = yerel dizin, $2 = hedef önek (turnuva tag'i)
  mc alias set fzr2 "$R2_ENDPOINT" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" >/dev/null
  mc cp --recursive "$1"/ "fzr2/$R2_BUCKET/$2/"
}

# tek yayın kilidi: eşzamanlı iki publish aynı çalışma kopyasında yarışır
# (2026-07-12'de yaşandı) — mkdir atomiktir, sahibi çıkınca kalkar
LOCK="$(pwd)/.publish/lock"
mkdir -p "$(pwd)/.publish"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "başka bir publish koşuyor ($LOCK) — bitmesini bekle"; exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

command -v gh >/dev/null || { echo "gh CLI gerekli (brew install gh)"; exit 1; }
curl -sf "${API}/api/v1/teams" >/dev/null || { echo "stats-svc yanıt vermiyor (${API}) — stüdyoyu başlat"; exit 1; }

# --- site çalışma kopyası: SITE_REPO'nun SITE_BRANCH dalı -------------------
# (kod reposunun gh-pages dalı olabilir — kodu klonlamamak için çıplak init)
if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$WORK"
  git -C "$WORK" init -q -b "$SITE_BRANCH"
  git -C "$WORK" remote add origin "https://github.com/${SITE_REPO}.git"
  git -C "$WORK" config user.name  "$(git config user.name  || echo freezetime)"
  git -C "$WORK" config user.email "$(git config user.email || echo freezetime@localhost)"
fi
git -C "$WORK" fetch -q origin "$SITE_BRANCH" 2>/dev/null \
  && git -C "$WORK" reset -q --hard "origin/$SITE_BRANCH" || true

# bundles-new asla git'e girmez (Releases'a gider) — .gitignore garanti
grep -qs '^bundles-new/$' "$WORK/.gitignore" 2>/dev/null || printf 'bundles-new/\n' >> "$WORK/.gitignore"

# Boş repoya GitHub Release açılamaz (422) — ilk commit'i garanti et.
# DİKKAT: add -A DEĞİL — export çıktıları (12GB paket) staging'de olabilir
if ! git -C "$WORK" rev-parse HEAD >/dev/null 2>&1; then
  touch "$WORK/.nojekyll"
  git -C "$WORK" add .nojekyll .gitignore
  git -C "$WORK" commit -q -m "init site"
  git -C "$WORK" push -q -u origin "$SITE_BRANCH"
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

# --- frontend (statik mod, taban yollu) --------------------------------------
(cd apps/web && VITE_STATIC=1 VITE_BASE="$VITE_BASE" npm run build)

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
# Site tarihçesi değersizdir ama her yayın ~300 MB sayfa verisini yeniden
# yazar; normal commit'lerle .git sınırsız büyür. Bu yüzden her yayın TEK
# amend'lenmiş commit olarak force-push edilir (Pages için sorunsuz).
matches=$(python3 -c "import json;print(len(json.load(open('$WORK/data/manifest.json'))['matches']))" 2>/dev/null || echo '?')
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "değişiklik yok — push atlanıyor"
else
  # ebeveynsiz commit: dal her yayında tek commit'e iner, eski tarihçe
  # gc ile atılır (yoksa amend bile eski ataları rehin tutar)
  TREE=$(git -C "$WORK" write-tree)
  NEW=$(git -C "$WORK" commit-tree "$TREE" -m "publish $(date -u +%Y-%m-%dT%H:%MZ) (${matches} matches)")
  git -C "$WORK" reset -q --soft "$NEW"
  git -C "$WORK" push -q --force -u origin "HEAD:$SITE_BRANCH"
  git -C "$WORK" reflog expire --expire=now --all 2>/dev/null || true
  git -C "$WORK" gc -q --prune=now 2>/dev/null || true
fi
echo "✔ publish tamam — ${matches} maç manifestte"
