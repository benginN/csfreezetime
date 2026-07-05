#!/usr/bin/env bash
# FREEZETIME sunucu kurulumu — Ubuntu 24.04, root, repo /opt/freezetime'da.
# İdempotent: yeniden çalıştırmak güvenlidir.
set -euo pipefail

ROOT=/opt/freezetime
cd "$ROOT"

[ -f infra/.env ] || { echo "HATA: infra/.env yok — Mac'ten kopyala (migrate-from-mac.sh env'i de taşır)"; }

echo "== paketler"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq git rsync curl build-essential pkg-config libssl-dev \
    protobuf-compiler golang-go ufw unar jq

echo "== docker"
if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi

echo "== rust"
if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"

echo "== uv"
if ! command -v uv >/dev/null && [ ! -x "$HOME/.local/bin/uv" ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

echo "== parser-worker derleniyor (ilk sefer ~5 dk)"
cargo build --release --manifest-path services/parser-worker/Cargo.toml

echo "== stats-svc derleniyor"
(cd services/stats-svc && go build -o stats-svc .)

echo "== python ortamları (uv sync)"
(cd services/enrichment && uv sync --no-editable)
(cd services/ml && uv sync --no-editable)

echo "== infra (docker compose)"
docker compose -f infra/docker-compose.yml up -d --wait postgres clickhouse minio nats || true
docker compose -f infra/docker-compose.yml up -d minio-init

echo "== şemalar"
scripts/apply-pg-schema.sh
scripts/apply-ch-schema.sh

echo "== systemd unit'leri"
cp deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now freezetime-stats freezetime-enrichment
for i in 1 2 3 4; do systemctl enable --now "freezetime-parser@$i"; done

echo "== güvenlik duvarı (yalnız SSH)"
ufw allow OpenSSH
ufw --force enable

echo
echo "KURULUM TAMAM. Kontrol:"
echo "  systemctl status freezetime-stats --no-pager | head -5"
echo "  curl -s localhost:8090/api/v1/matches | head -c 200"
