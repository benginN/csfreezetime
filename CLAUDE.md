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

## Mevcut faz
Şu an Faz 0'dayız: docker-compose altyapısı + Rust parser worker dikey dilimi.
Faz tanımları ve çıkış kriterleri `docs/mimari.md` §11'dedir. Faz 0 tamamlanma
kriteri: tek bir .dem dosyası < 5 sn'de parse edilip ClickHouse'ta
sorgulanabiliyor olmalı.
