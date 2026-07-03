# TacticalMind — CS2 Analiz Platformu

Profesyonel CS2 takımları için demo analiz platformu: demolar bir kez derinlemesine
işlenir, koçun tüm sorguları önceden hesaplanmış tablolara düşer
("parse once, query forever"). Mimari referansı: [docs/mimari.md](docs/mimari.md).

> **Not:** LLM/dış AI servisi kullanılmaz (v0.2 kararı). Tüm analizler
> deterministik SQL + geometri; ileride eklenecek tahmin/anomali modülleri de
> sunucuda çalışan yerel istatistik yöntemleridir — kullanım başına maliyet yok.

## Bileşenler

| Dizin | Dil | Görev |
|---|---|---|
| `services/parser-worker` | Rust | `demo.ingested` → .dem indir → parse → ClickHouse tick + PostgreSQL meta |
| `services/enrichment` | Python | `demo.parsed` → trade/first-kill, buy sınıfı, ilk-grenade → `demo.enriched` |
| `services/stats-svc` | Go | DSL→SQL sorgu motoru, ısı haritası, replay ve stacking API'si (:8090) |
| `infra/` | — | docker-compose: PostgreSQL 16, ClickHouse, MinIO, NATS JetStream |
| `scripts/` | — | şema uygulama, toplu ingest, uçtan uca testler |

## Hızlı başlangıç

```bash
# 1. Altyapı
cd infra && cp .env.example .env && docker compose up -d --wait postgres clickhouse minio nats
docker compose up -d minio-init && cd ..
scripts/apply-pg-schema.sh && scripts/apply-ch-schema.sh

# 2. Worker'lar (ayrı terminallerde, repo kökünden)
set -a; source infra/.env; set +a
cargo run --release --manifest-path services/parser-worker/Cargo.toml
(cd services/enrichment && uv run --no-editable enrichment-worker)
(cd services/stats-svc && go build -o stats-svc . ) && ./services/stats-svc/stats-svc

# 3. Demo yükle (test-data/*.dem dosyalarını kuyruğa verir, işlenmişleri atlar)
scripts/ingest-dir.sh

# 4. Test sayfası
open http://localhost:8090   # replay, stacking, DSL, ısı haritası

# 5. Testler
scripts/e2e-test.sh          # boru hattı uçtan uca
scripts/test-dsl.sh          # 20 golden DSL + replay/stack + p95
```

## stats-svc API (v1)

| Endpoint | Açıklama |
|---|---|
| `POST /api/v1/query` | DSL sorgusu (şema: `GET /api/v1/schema`) → clips / rounds / aggregate |
| `GET /api/v1/heatmap?map=&side=&buy_type=` | Tüm 1 sn zaman kovaları; kaydırıcı istemcide toplar |
| `GET /api/v1/maplayout?map=` | Pozisyon verisinden türetilen yürünebilir alan silüeti + bölge etiketleri |
| `GET /api/v1/matches` · `/matches/{id}` | Maç listesi · raunt + kill detayı |
| `GET /api/v1/rounds/{match}/{n}/ticks` | Rauntun 16 Hz akışı, radar koordinatlı, kill işaretli |
| `POST /api/v1/stack` | Multi-View Stacking: ≤10 raunt, `round_start\|bomb_plant\|first_kill` hizalama |

## Faz durumu (mimari.md §11)

- ✅ Faz 0 — altyapı + Rust parser (demo < 5 sn'de sorgulanabilir)
- ✅ Faz 1 — PG şeması + enrichment (trade, buy sınıfları)
- ✅ Faz 2 — heatmap_grid + DSL motoru (20 sorgu kalıbı, p95 ~60 ms)
- ✅ Faz 3 (revize) — replay endpoint'leri + Multi-View Stacking + radar kalibrasyonu
- ⬜ Faz 4 — yerel istatistik modülleri (kümeleme, tahmin, anomali)
- ⬜ Frontend — React + TypeScript + PixiJS SPA
