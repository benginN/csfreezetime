#!/usr/bin/env bash
# sync-memory.sh — Claude Code proje hafızasını yedekler (mimari §11.1 düzeni):
#   canlı hafıza (~/.claude/projects/<repo-yolu>/memory)
#     → T7 yedeği + private GitHub reposu (freezetime-claudememoryforbackup)
# post-commit hook'undan otomatik çağrılır; elle de koşturulabilir.
# KURTARMA (yeni makine): private repoyu klonla, memory/ içeriğini
#   ~/.claude/projects/-Volumes-T7-cs2-freezetime-cs2-platform/memory/ altına
#   kopyala — Claude Code tüm proje geçmişini bilerek açılır.
set -uo pipefail

BACKUP=/Volumes/T7/cs2-freezetime/memory-backup
LIVE_NEW="$HOME/.claude/projects/-Volumes-T7-cs2-freezetime-cs2-platform/memory"
LIVE_OLD="$HOME/.claude/projects/-Users-bengin-Desktop-cs2-platform/memory"

[ -d "$BACKUP/.git" ] || exit 0   # T7 takılı değil / klon yok → sessizce geç
mkdir -p "$LIVE_NEW"

# eski (Desktop dönemi) yol hâlâ duruyorsa: daha yeni dosyaları yeni yola al
[ -d "$LIVE_OLD" ] && rsync -au "$LIVE_OLD/" "$LIVE_NEW/" 2>/dev/null

rsync -a --delete "$LIVE_NEW/" "$BACKUP/memory/" 2>/dev/null || exit 0
cd "$BACKUP" || exit 0
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "sync memory $(date -u +%Y-%m-%dT%H:%MZ)"
  git push -q origin HEAD 2>/dev/null || true   # çevrimdışıysa sonraki push telafi eder
fi
