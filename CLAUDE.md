# CS2 Analiz Platformu — Proje Talimatları

## Referans doküman
Tüm mimari kararlar `docs/mimari.md` dosyasındadır. Herhangi bir tasarım kararı
vermeden önce bu dokümanı kontrol et. Dokümana aykırı bir yaklaşım gerekiyorsa
uygulamadan önce mutlaka sor ve gerekçesini açıkla.

## Teknoloji kuralları
- `services/parser-worker` → Rust (demoparser çekirdeği, Arrow/Parquet çıktı)
- `services/ingest-svc`, `services/stats-svc` → Go 1.22+
- `services/enrichment`, `services/ml` → Python 3.11+ (bağımlılıklar `uv` ile)
- Mesajlaşma: NATS JetStream · Meta veri: PostgreSQL 16 · Tick verisi: ClickHouse
- Tick/pozisyon verisi ASLA PostgreSQL'e yazılmaz; ilişkisel meta veri ASLA
  ClickHouse'a yazılmaz. Şüphedeysen `docs/mimari.md` §5.1'e bak.

## Yerel ortam
- Başlat: `docker compose -f infra/docker-compose.yml up -d`
- Durum:  `docker compose -f infra/docker-compose.yml ps`
- Bağlantı bilgileri `infra/.env.example` şablonundadır; gerçek değerler `.env`
  dosyasında tutulur ve asla commit edilmez.

## Çalışma kuralları
- Her özellik için önce kısa bir plan sun, onay al, sonra uygula.
- Her serviste birim testi zorunludur; işi bitirmeden testleri çalıştır ve
  sonucu raporla.
- Veritabanı şemasında her değişiklik = migration dosyası + `docs/mimari.md`
  güncellemesi (ikisi birlikte, aynı commit'te).
- Commit mesajları İngilizce ve emir kipinde ("add parser retry logic").
- `test-data/` içindeki .dem dosyaları büyüktür; git'e asla ekleme
  (.gitignore'da tanımlı).

## Durum
Faz 0-5 + LightGBM v2 tamamlandı; platform çalışır ve özellik-tam durumda
(replay, raporlar, Pattern Finder, Scenarios, ML Lab, My DB). Proje MIT
lisansıyla açık kaynaktır. Faz tanımları ve tarihçe `docs/mimari.md` §11'de;
projeye yeni gelen için sade tur `docs/how-it-works.md`. Yeni özellik
eklerken: önce kısa plan sun, onay al, sonra uygula (yukarıdaki çalışma
kuralları geçerli).
