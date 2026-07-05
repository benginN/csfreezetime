# FREEZETIME — Hetzner sunucu kurulumu

Hedef makine: AX41-NVMe (Ryzen 5 3600, 64 GB, 2×512 GB NVMe → RAID0 = ~1 TB),
Ubuntu 24.04. Dışarıya yalnız SSH açık; siteye `ssh -L` tüneliyle erişilir
(auth fazına kadar internete açılmaz).

## 0) Sipariş sonrası ilk kurulum (RAID0)

Hetzner dedicated sunucular Rescue System ile teslim edilir (ya da Robot →
Rescue sekmesinden aktive et → reset). Rescue'ya ssh ile gir ve:

```
installimage
```

Menüden **Ubuntu 24.04** seç; açılan config dosyasında şunları ayarla:

```
SWRAID 1
SWRAIDLEVEL 0        # iki NVMe birleşir -> ~1 TB (yedeksiz, bilinçli karar)
HOSTNAME freezetime
PART /boot ext3 1024M
PART / ext4 all
```

Kaydet-çık, kurulum bitince `reboot`. Artık `ssh root@<ip>` doğrudan girer.

## 1) Kurulum (sunucuda, root)

Mac'ten repo'yu gönder (dist dahil; ağır üretilebilir klasörler hariç):

```
cd ~/Desktop/cs2-platform && npm --prefix apps/web run build
rsync -az --exclude target --exclude node_modules --exclude .venv \
      --exclude '.git/objects/pack/*.idx' \
      ./ root@<ip>:/opt/freezetime/
```

Sonra sunucuda:

```
bash /opt/freezetime/deploy/setup-server.sh
```

Script: Docker + Go + Rust + protoc + uv kurar, parser-worker'ı derler,
infra compose'u kaldırır, PG/CH şemalarını uygular, systemd unit'lerini
kurar ve ufw'yu (yalnız SSH) açar.

## 2) Veri taşıma (Mac'te çalıştırılır)

```
bash deploy/migrate-from-mac.sh <ip>
```

Sırasıyla: PG dump'ı taşır ve geri yükler (maçlar/takımlar/notlar/playlist
UUID'leri korunur), MinIO `raw/` kovasını aynalar (~200 GB, gece bırak),
sonra tüm arşiv için reprocess tetikler (CH sunucuda yeniden kurulur,
6C/12T ile ~2 saat). ml-auto ingest durulunca kendiliğinden koşar.

## 3) Günlük kullanım

- UI: `ssh -L 8090:localhost:8090 root@<ip>` → tarayıcıda `localhost:8090`
  (admin panelleri için `?admin=<ADMIN_TOKEN>`)
- Yeni demo: `rsync -av *.rar root@<ip>:/opt/freezetime/backfill/` —
  izleyici 20 sn'de bir tarar, gerisi otomatik.
- Servis durumu: `systemctl status freezetime-stats freezetime-enrichment
  'freezetime-parser@*'`
- Loglar: `journalctl -u freezetime-stats -f`

## Notlar

- `.env` migrate script'iyle kopyalanır; commit edilmez (CLAUDE.md kuralı).
- RAID0 + yedek yok: disk arızasında kurtarma = HLTV'den yeniden indirme
  (~1 gece) + reprocess (~2 saat). Bilinçli tercih (2026-07-05).
- Parser worker sayısı: 4 (6 çekirdekte CH'ye pay bırakır). Artırmak:
  `systemctl enable --now freezetime-parser@5`
