-- Ham kasası (mimari §11.1 statik model + 2026-07-11 kullanıcı kararı):
-- mevcut arşivin (Jul'25-Jul'26 S-tier) ham kopyaları MinIO'da KORUNUR
-- (parser evrimi sigortası, SSD = yıllık kasa); bundan SONRA işlenen
-- maçların hamı, RAW_DELETE_AFTER_READY=1 iken ready'ye geçince silinir.
-- Kasa işaretleme (mevcut arşivi koru) bu migration'la değil, geçiş
-- anında elle koşulur: UPDATE matches SET raw_vault = TRUE WHERE status='ready';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS raw_vault BOOLEAN NOT NULL DEFAULT false;
