# CS2 Yapay Zekâ Destekli Analiz ve Taktik Platformu
## Sistem Mimarisi ve Teknik Tasarım Dokümanı

> **Revizyon notu (v0.2, 2026-07-03):** Ürün kararıyla **LLM/Claude API entegrasyonu tamamen iptal edilmiştir** (kullanım başına token maliyeti istenmiyor; platform dış AI servisine veri göndermez). Bu kararla: §6.1'deki NLP arama motorunun LLM çeviri katmanı yapılmayacak — DSL sorgu motoru form arayüzüyle kalıcı çözümdür; embedding tabanlı hibrit arama ve raunt anlatıları da kapsam dışıdır. §6.2 ve §6.3'teki **yerel** istatistik modülleri (kümeleme, tahmin, anomali — sunucuda çalışır, kullanım ücreti yoktur) yol haritasında korunmaktadır. §11'deki Faz 3, "replay endpoint'leri + Multi-View Stacking + radar kalibrasyonu" olarak revize edilmiş ve tamamlanmıştır.

| | |
|---|---|
| **Doküman sürümü** | v0.2 (LLM iptal revizyonu) |
| **Kapsam** | Uçtan uca sistem mimarisi, veritabanı şeması, AI/ML entegrasyon yol haritası, demo parser mimarisi |
| **Hedef kitle** | Kurucu ekip, backend/ML mühendisleri, ürün yönetimi |
| **Kod adı** | *(çalışma adı)* TacticalMind |

---

## 1. Yönetici Özeti ve Mimari Prensipler

Platform, profesyonel CS2 takımlarının koç ve analistlerine üç ayırt edici yetenek sunar: doğal dille demo arşivinde arama (NLP arama motoru), rakibin bir sonraki raunt davranışına dair kalibre edilmiş olasılık tahmini (predictive anti-strat) ve oyuncu mekaniğindeki mikro hataların otomatik tespiti (anomali motoru). Skybox, Leetify ve Noesis'in sunduğu klasik 2D replay ve istatistik katmanı burada temel altyapıdır; farklılaşma tamamen veri işleme derinliğinden ve AI katmanından gelir.

Tasarımın tamamına yayılan beş prensip vardır:

**"Parse once, query forever."** Demolar bir kez, ingest anında derinlemesine işlenir; her türlü türetilmiş metrik (trade süreleri, buy sınıfları, bölge geçişleri, ısı haritası ızgaraları, raunt anlatıları, embedding'ler) bu aşamada önceden hesaplanır. Koçun sorguları asla ham tick verisini taramaz, her zaman önceden hesaplanmış agregat ve indekslere düşer. "Milisaniyeler içinde sonuç" hedefi bu şekilde karşılanır: bir demonun tam ayrıştırılması fiziksel olarak saniyeler sürer (aşağıda gerçekçi SLA'lar verilmiştir), ancak koçun deneyimlediği sorgu gecikmesi milisaniye/saniye mertebesinde kalır çünkü ağır iş çoktan yapılmıştır.

**Olay güdümlü (event-driven) ve modüler.** Servisler bir mesaj kuyruğu (NATS JetStream) üzerinden gevşek bağlıdır. Parser, zenginleştirme (enrichment) ve ML servisleri birbirinden bağımsız ölçeklenir ve bağımsız deploy edilir.

**Polyglot persistence.** Tek veritabanı bu iş yükünü taşıyamaz. İlişkisel meta veri PostgreSQL'de, yüksek hacimli tick/pozisyon verisi ClickHouse'ta, semantik arama vektörleri pgvector/Qdrant'ta, ham demolar ve Parquet dökümleri S3 uyumlu obje depolamada tutulur.

**Demo verisi > bilgisayarlı görü.** Kritik bir tasarım kararı: crosshair placement ve trade analizi için bilgisayarlı görüye (CV) gerek yoktur, çünkü .dem dosyası her oyuncunun bakış açısını (yaw/pitch) her tick'te *kesin değer* olarak içerir. CV'nin piksellerden tahmin edeceği şeyin yer gerçeği (ground truth) elimizdedir; bu hem daha doğru hem de çok daha ucuzdur. CV, yalnızca demo dosyası olmayan video kaynakları (ör. rakibin yayın POV'ları) için opsiyonel bir yan modül olarak yol haritasında tutulur (Bkz. §6.3).

**Multi-tenant gizlilik.** Scrim demoları bir takımın en değerli sırrıdır. Organizasyon bazlı veri izolasyonu (PostgreSQL row-level security + nesne depolamada prefix izolasyonu) birinci sınıf gereksinimdir, sonradan eklenecek bir özellik değildir.

---

## 2. Üst Düzey Sistem Mimarisi

```
  Demo Kaynakları                         Koç / Analist (Tarayıcı)
  (Scrim GOTV, turnuva,                   ┌─────────────────────────┐
   FACEIT, manuel upload)                 │ React SPA + PixiJS/WebGL│
        │                                 └───────────┬─────────────┘
        │  HTTPS upload / fetch                       │ HTTPS + WebSocket
        ▼                                             ▼
  ┌───────────────┐                       ┌───────────────────────┐
  │ Ingest Servisi│                       │  API Gateway (Go)     │
  │ (Go)          │                       │  REST + WS + AuthZ    │
  └───────┬───────┘                       └───┬───────────────┬───┘
          │ .dem → S3                         │               │
          ▼                                   ▼               ▼
  ┌───────────────┐   demo.ingested   ┌──────────────┐ ┌─────────────────┐
  │  MinIO / S3   │ ───────────────▶  │ Stats/Query  │ │ NLP Query       │
  │ (.dem,Parquet)│    (NATS)         │ Servisi (Go) │ │ Servisi (Py+LLM)│
  └───────────────┘                   └──────┬───────┘ └───────┬─────────┘
          ▲                                  │                 │
          │                                  ▼                 ▼
  ┌───────┴────────┐  bulk insert   ┌──────────────┐   ┌──────────────┐
  │ Parser Worker  │ ─────────────▶ │  ClickHouse  │   │  PostgreSQL  │
  │ Havuzu (Rust)  │                │ (tick/event) │   │ (meta+vektör)│
  └───────┬────────┘                └──────▲───────┘   └──────▲───────┘
          │ demo.parsed                    │                  │
          ▼                                │                  │
  ┌────────────────┐  demo.enriched  ┌─────┴──────────┐  ┌────┴─────────┐
  │ Enrichment     │ ──────────────▶ │ ML Inference   │  │ Model Eğitim │
  │ Worker (Python)│                 │ (FastAPI+ONNX) │  │ (Dagster+GPU)│
  └────────────────┘                 └────────────────┘  └──────────────┘
```

Veri akışı şu adımlarla ilerler. (1) Demo, Ingest Servisi'ne yüklenir veya otomatik çekilir; SHA-256 özeti hesaplanır, tekrarlı yüklemeler burada elenir ve dosya S3'e yazılır. (2) `demo.ingested` olayı NATS'e düşer; boştaki bir Rust parser worker'ı işi alır, demoyu tam ayrıştırır, tick/event verisini ClickHouse'a, meta veriyi PostgreSQL'e, ham kolonsal dökümü Parquet olarak S3'e yazar. (3) `demo.parsed` olayıyla Python enrichment worker'ları devreye girer: trade hesapları, buy sınıflandırması, bölge (place) atamaları, raunt anlatı metinleri ve embedding'ler, ısı haritası ızgara agregatları üretilir. (4) `demo.enriched` sonrası ML servisleri strateji kümesi ataması ve anomali taraması yapar; sonuçlar veritabanına yazılır ve WebSocket üzerinden arayüze anlık bildirilir. (5) Koç arayüzden sorgu attığında istek ya Stats/Query servisine (yapılandırılmış filtreler) ya da NLP Query servisine (doğal dil) gider; her ikisi de önceden hesaplanmış tablolara karşı çalışır.

---

## 3. Teknoloji Yığını (Tech Stack)

| Katman | Birincil seçim | Alternatif | Gerekçe (özet) |
|---|---|---|---|
| Demo parser | **Rust** (`demoparser2` çekirdeği) | Go (`demoinfocs-golang` v4) | Ham hız + Arrow kolonsal çıktı; Python binding'i ML tarafıyla sıfır sürtünme |
| Backend API | **Go** (chi/echo, gRPC) | Rust (axum) | Yüksek eşzamanlılık, WebSocket, düşük GC duraklaması, hızlı geliştirme |
| ML / AI servisleri | **Python 3.11+** (FastAPI, PyTorch, LightGBM) | — | Ekosistem standardı; PyTorch, TensorFlow'a tercih edilir (araştırma hızı, ONNX ihracı) |
| Mesaj kuyruğu | **NATS JetStream** | Kafka | Hafif operasyon, iş kuyruğu + olay yayını tek sistemde; Kafka ancak çok yüksek hacimde gerekir |
| Analitik / zaman serisi DB | **ClickHouse** | TimescaleDB, QuestDB | Milyarlarca pozisyon satırında sütunsal sıkıştırma + saniye altı agregasyon |
| İlişkisel DB | **PostgreSQL 16** | — | Meta veri, kullanıcı/yetki, düşük hacimli olaylar (kill, grenade), RLS ile multi-tenancy |
| Vektör arama | **pgvector** (başlangıç) → Qdrant (ölçekte) | Weaviate | Başlangıçta ekstra sistem yükü olmadan PG içinde; >10M vektörde Qdrant |
| Cache / pub-sub | **Redis** | — | Sorgu cache'i, oturum, tahmin sonuçları |
| Obje depolama | **S3 / MinIO** | — | Ham .dem + Parquet arşivi; yeniden işleme (reprocessing) sigortası |
| Frontend | **React 18 + TypeScript** | — | Ekosistem, ekip bulunabilirliği |
| 2D render | **PixiJS (WebGL2)** | saf Canvas 2D | 10 oyuncu × N katman × 60 fps + ısı haritası shader'ları için GPU şart |
| Frontend veri | TanStack Query + Zustand + `parquet-wasm` | — | Kolonsal veriyi tarayıcıda sıfır kopya çözme |
| Pipeline orkestrasyonu | **Dagster** | Airflow | Veri + ML varlıklarını (assets) tek grafikte yönetme, güçlü backfill |
| ML deney/model kaydı | **MLflow** | Weights & Biases | Model versiyonlama, kalibrasyon raporları |
| LLM (NLP arama) | **Claude API** (structured output) | Fine-tuned Llama/Qwen (on-prem) | v1'de hızlı doğruluk; maliyet/gizlilik gerekirse açık modele geçiş yolu açık |
| Embedding modeli | **bge-m3** veya multilingual-e5 | — | Çok dilli (TR+EN sorgular) semantik arama |
| Deploy | **Kubernetes + KEDA** | Nomad | Kuyruk derinliğine göre parser worker autoscaling |
| Gözlemlenebilirlik | Prometheus + Grafana + OpenTelemetry + Loki | — | Parse süreleri, kuyruk gecikmesi, model drift metrikleri |

**Zaman serisi veritabanı sorusunun cevabı — neden ClickHouse?** Bu iş yükünün doğası "zaman serisi" görünümlü ama aslında *analitik/OLAP*'tır: "Vertigo'da T tarafının full buy rauntlarında ilk 30 saniyedeki pozisyon yoğunluğu" gibi sorgular milyonlarca satırı gruplayıp toplar. ClickHouse'un sütunsal depolaması pozisyon verisini 10-20 kata kadar sıkıştırır ve `GROUP BY` agregasyonlarını saniye altında döndürür; ayrıca materialized view'larıyla ısı haritası ızgaraları ingest anında bedavaya hesaplanır. TimescaleDB, ekip tek bir PostgreSQL yığınında kalmak isterse kabul edilebilir bir B planıdır ancak bu hacimde sorgu performansı belirgin biçimde geridedir. **MongoDB bu iş için uygun değildir**: doküman modeli ne sütunsal agregasyon performansı ne de bu verinin ilişkisel doğasına karşılık verir.

---

## 4. Demo Parser Mimarisi

### 4.1 Source 2 .dem formatının doğası

CS2 demoları, Source 1'in aksine, protobuf çerçeveli bir akıştır: `CDemoPacket` / `CDemoFullPacket` mesajları, string table'lar ve *flattened serializer* tabanlı delta entity güncellemeleri içerir. Pratik sonuçları şunlardır: (a) format resmi olarak dokümante edilmemiştir, topluluk parser'ları Valve güncellemeleriyle kırılabilir — parser sürümleme ve yeniden işleme stratejisi zorunludur; (b) her tick'te her oyuncunun pozisyonu, bakış açısı (yaw/pitch), hızı, sağlığı, aktif silahı, flash süresi gibi alanlar delta olarak gelir ve tam durum ancak akış baştan okunarak kurulur; (c) sunucu tick oranı 64'tür.

### 4.2 Parser seçimi

İki olgun aday vardır ve ikisi de CS2/Source 2 destekler:

| | `demoparser2` (Rust + Python binding) | `demoinfocs-golang` v4 (Go) |
|---|---|---|
| Performans | En hızlı sınıf; tipik bir maç demosu tek çekirdekte ~1-3 sn'de tam ayrıştırılır | Hızlı, Rust'a yakın ama genelde biraz geride |
| Çıktı modeli | Kolonsal (Arrow/Polars DataFrame) — ClickHouse ve Parquet'e doğrudan akar | Olay güdümlü (event handler) API — akış işleme için çok ergonomik |
| ML entegrasyonu | Python binding'i sayesinde enrichment koduna sıfır sürtünme | Go→Python köprüsü gerekir |
| Önerim | **Birincil çekirdek** | Doğrulama/çapraz kontrol parser'ı ve canlı GOTV akışı için aday |

Karar: parser worker'ları Rust ile yazılır ve `demoparser2`'nin çekirdek kütüphanesini kullanır; çıktı Arrow RecordBatch olarak üretilip hem Parquet'e hem ClickHouse'un native protokolüne akıtılır. C++ ile sıfırdan parser yazmak (Valve'ın kendi demoinfo2 örneği üzerine) yalnızca formatın kütüphanelerce desteklenmeyen bir köşesine ihtiyaç duyulursa gündeme alınır — bakım maliyeti yüksektir.

### 4.3 İşleme hattı ve servisler arası iletişim

```
Ingest (Go)                Parser Worker (Rust)              Enrichment (Python)
────────────               ─────────────────────             ───────────────────
1. .dem al                 4. demo.ingested tüket (NATS)     9. demo.parsed tüket
2. SHA-256 + dedup         5. Pass A: header, tick oranı,    10. Trade/first-kill türet
3. S3'e yaz,                  raunt sınırları, oyuncu eşleme 11. Buy sınıflandır
   demo.ingested yayınla   6. Pass B: tam entity akışı →     12. Place/bölge ata
                              Arrow batch'leri               13. Isı haritası MV tetikle
                           7. Yaz: Parquet→S3,               14. Raunt anlatısı + embedding
                              ClickHouse bulk insert,        15. demo.enriched yayınla →
                              PG meta veri                       ML servisleri (küme, anomali)
                           8. demo.parsed yayınla
```

Servisler arası sözleşme NATS üzerinde JSON (veya protobuf) olaylardır; örnek `demo.parsed` yükü:

```json
{
  "event": "demo.parsed",
  "demo_sha256": "9f8a…",
  "match_id": "7c1e4b2a-…",
  "map": "de_vertigo",
  "parser_version": "0.4.2",
  "row_counts": { "player_ticks": 1743200, "kills": 168, "grenades": 402 },
  "duration_ms": 2140,
  "warnings": []
}
```

Tasarım detayları: **idempotency** anahtarı `demo_sha256`'dır; aynı demo ikinci kez asla işlenmez, ancak `parser_version` yükseltildiğinde Dagster üzerinden kontrollü bir *reprocessing backfill* çalıştırılır (Parquet arşivi sayesinde .dem'i yeniden indirmeden). Başarısız işler 3 denemeden sonra dead-letter kuyruğuna düşer ve arayüzde "parse hatası" olarak işaretlenir. Worker havuzu KEDA ile kuyruk derinliğine göre 0-N arasında ölçeklenir; büyük backfill'lerde (ör. bir liginin sezonu) onlarca worker paralel çalışır.

**Tick örnekleme stratejisi:** Pozisyon verisi varsayılan olarak 16 Hz'e indirgenerek saklanır (analitik için fazlasıyla yeterli, hacmi 4'e böler); kill/shot/damage olayları ise tam tick hassasiyetinde tutulur ve olay anının ±0,5 sn çevresindeki bakış açıları tam 64 Hz saklanır (crosshair analizi için gerekli). Ham Parquet dökümü her zaman tam çözünürlüktedir; ileride daha yüksek çözünürlük gerekirse kaynak oradadır.

### 4.4 Gerçekçi performans ve SLA hedefleri

| Metrik | Hedef |
|---|---|
| Tek demo tam parse (1 worker çekirdeği) | 1-3 sn (Rust) |
| Upload → arayüzde analize hazır (uçtan uca) | < 90 sn (p95) |
| Toplu backfill verimi | ~20-40 demo/dk/worker (I/O dahil) |
| NLP arama yanıtı | < 2 sn (p95) |
| Yapılandırılmış istatistik sorgusu / ısı haritası | < 300 ms (p95, ön-agregatlardan) |
| Raunt sonu tahmin çıkarımı (anti-strat) | < 100 ms |

Not: pazarlama dilindeki "milisaniyede parse" ifadesi teknik dokümanda "milisaniyede *sorgu*, saniyelerde *parse*" olarak netleştirilmelidir; fizik bunu gerektirir ve mimari zaten koç deneyimini anlık kılar.

### 4.5 Koordinat dönüşümü ve bölge (place) haritalama

Dünya koordinatları (X,Y,Z) → 2D radar koordinatları dönüşümü, her haritanın overview meta verisiyle yapılır ve `maps` tablosunda tutulur:

```
radar_x = (world_x - radar_pos_x) / radar_scale
radar_y = (radar_pos_y - world_y) / radar_scale
```

Çok katlı haritalarda (Vertigo, Nuke) `level_split_z` eşiğiyle üst/alt kat radar görselleri arasında geçiş yapılır. NLP motorunun "A rampası" gibi ifadeleri koordinatlara bağlayabilmesi için, oyunun nav-mesh place isimleri (`RampA`, `BombsiteB`…) poligon olarak `map_areas` tablosuna işlenir ve Türkçe/İngilizce takma adlarla (alias) zenginleştirilir. Parser, her pozisyon satırına o anki `place` etiketini ingest sırasında yazar — böylece bölge bazlı tüm sorgular ucuz string filtrelerine dönüşür.

---

## 5. Veritabanı Şeması Taslağı

### 5.1 Sorumluluk paylaşımı

PostgreSQL "kayıt sistemi"dir (source of truth): kimlikler, maç/raunt meta verisi ve *düşük hacimli* olaylar (kill'ler maç başına ~150-200 satır, grenade'ler ~400 satırdır — ilişkisel join'lerle çalışmak değerlidir). ClickHouse "analitik motor"dur: pozisyon tick'leri, silah atışları, hasar olayları ve tüm ön-agregatlar orada yaşar. İki dünya, her iki tarafta da bulunan `match_id` (UUID) ve `round_number` anahtarlarıyla köprülenir; uygulama katmanı çapraz sorguları birleştirir.

Hacim gerçekliği: 16 Hz örneklemede ortalama bir maç ≈ 450 bin pozisyon satırı üretir (10 oyuncu × ~115 sn/raunt × ~25 raunt × 16 Hz). 10.000 maçlık bir arşiv ≈ 4,5 milyar satırdır — ClickHouse için rutin, PostgreSQL için imkânsız bir yük.

### 5.2 PostgreSQL şeması (çekirdek DDL)

```sql
-- Kimlik ve organizasyon ─────────────────────────────────────────────
CREATE TABLE orgs (                       -- multi-tenancy kökü
    org_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL
);

CREATE TABLE teams (
    team_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    tag         TEXT,
    region      TEXT
);

CREATE TABLE players (
    player_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    steam_id64      BIGINT UNIQUE NOT NULL,
    nickname        TEXT NOT NULL,
    current_team_id UUID REFERENCES teams(team_id),
    role            TEXT CHECK (role IN ('igl','awp','entry','support','lurker','flex'))
);

-- Harita kalibrasyonu ve bölgeler ────────────────────────────────────
CREATE TABLE maps (
    map_name        TEXT PRIMARY KEY,      -- 'de_vertigo'
    radar_pos_x     REAL NOT NULL,
    radar_pos_y     REAL NOT NULL,
    radar_scale     REAL NOT NULL,
    has_lower_level BOOLEAN DEFAULT FALSE,
    level_split_z   REAL
);

CREATE TABLE map_areas (
    area_id     SERIAL PRIMARY KEY,
    map_name    TEXT REFERENCES maps(map_name),
    place_name  TEXT NOT NULL,             -- nav-mesh adı: 'RampA'
    aliases     TEXT[] NOT NULL,           -- {'A ramp','A rampası','ramp'}
    polygon     JSONB NOT NULL             -- [[x,y], ...] dünya koordinatı
);

-- Maç ve raunt ───────────────────────────────────────────────────────
CREATE TABLE matches (
    match_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES orgs(org_id),   -- RLS anahtarı
    demo_sha256     TEXT UNIQUE NOT NULL,
    demo_object_key TEXT NOT NULL,         -- S3 yolu
    source          TEXT,                  -- 'scrim' | 'official' | 'faceit'
    event_name      TEXT,
    map_name        TEXT REFERENCES maps(map_name),
    team_a_id       UUID REFERENCES teams(team_id),
    team_b_id       UUID REFERENCES teams(team_id),
    score_a         SMALLINT, score_b SMALLINT,
    tick_rate       SMALLINT DEFAULT 64,
    played_at       TIMESTAMPTZ,
    tournament      TEXT,  -- backfill arşiv adından türetilir; ml-jobs takım adlarını ayıklar
    parser_version  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','parsing','enriching','ready','failed'))
);

CREATE TABLE rounds (
    match_id        UUID REFERENCES matches(match_id) ON DELETE CASCADE,
    round_number    SMALLINT NOT NULL,
    start_tick      INT, freeze_end_tick INT, end_tick INT,
    winner_side     TEXT CHECK (winner_side IN ('T','CT')),
    end_reason      TEXT,                  -- bomb_exploded|defused|elimination|time
    bomb_plant_tick INT,
    bomb_site       TEXT,                  -- 'A' | 'B'
    t_team_id       UUID REFERENCES teams(team_id),  -- side swap çözümü
    ct_team_id      UUID REFERENCES teams(team_id),
    t_equip_value   INT, ct_equip_value INT,
    t_buy_type      TEXT CHECK (t_buy_type IN ('pistol','eco','semi','force','full')),
    ct_buy_type     TEXT CHECK (ct_buy_type IN ('pistol','eco','semi','force','full')),
    t_strategy_cluster  SMALLINT,          -- ML atar (§6.2), NULL = henüz yok
    ct_strategy_cluster SMALLINT,
    PRIMARY KEY (match_id, round_number)
);

-- Oyuncu-raunt köprüsü: ekonomi + raunt içi özet ─────────────────────
CREATE TABLE player_round_states (
    match_id     UUID,
    round_number SMALLINT,
    player_id    UUID REFERENCES players(player_id),
    side         TEXT CHECK (side IN ('T','CT')),
    money_start  INT, money_spent INT, equip_value INT,
    survived     BOOLEAN,
    kills SMALLINT, deaths SMALLINT, assists SMALLINT,
    damage_dealt SMALLINT, flash_assists SMALLINT,
    util_he_dmg SMALLINT, util_fire_dmg SMALLINT,  -- HE / molotof-inferno hasarı (utility verimliliği)
    PRIMARY KEY (match_id, round_number, player_id),
    FOREIGN KEY (match_id, round_number)
        REFERENCES rounds(match_id, round_number) ON DELETE CASCADE
);

-- Düşük hacimli olaylar ──────────────────────────────────────────────
CREATE TABLE kills (
    kill_id       BIGSERIAL PRIMARY KEY,
    match_id      UUID, round_number SMALLINT,
    tick          INT, round_time REAL,     -- freeze sonrası saniye
    attacker_id   UUID, victim_id UUID, assister_id UUID,
    weapon        TEXT,
    headshot BOOLEAN, wallbang BOOLEAN, noscope BOOLEAN,
    through_smoke BOOLEAN, attacker_blind BOOLEAN, victim_blind BOOLEAN,
    attacker_x REAL, attacker_y REAL, attacker_z REAL,
    victim_x   REAL, victim_y   REAL, victim_z   REAL,
    attacker_place TEXT, victim_place TEXT,
    is_first_kill BOOLEAN,                  -- rauntun açılış kill'i
    is_trade      BOOLEAN,                  -- enrichment hesaplar
    trade_time_ms INT,                      -- takım arkadaşı ölümünden bu kill'e
    FOREIGN KEY (match_id, round_number)
        REFERENCES rounds(match_id, round_number) ON DELETE CASCADE
);
CREATE INDEX ON kills (match_id, round_number);
CREATE INDEX ON kills (attacker_id);
CREATE INDEX ON kills (victim_id);

CREATE TABLE grenades (
    grenade_id    BIGSERIAL PRIMARY KEY,
    match_id      UUID, round_number SMALLINT,
    thrower_id    UUID, side TEXT,
    type          TEXT CHECK (type IN ('flash','smoke','he','molotov','incendiary','decoy')),
    throw_tick INT, detonate_tick INT, round_time_throw REAL,
    throw_x REAL, throw_y REAL, throw_z REAL,
    det_x   REAL, det_y   REAL, det_z   REAL,
    det_place TEXT,
    is_first_of_type_in_round BOOLEAN,      -- "ilk flash" sorguları için ön-hesap
    enemies_flashed SMALLINT, teammates_flashed SMALLINT,
    total_enemy_blind_time REAL,
    damage_dealt SMALLINT,
    FOREIGN KEY (match_id, round_number)
        REFERENCES rounds(match_id, round_number) ON DELETE CASCADE
);
CREATE INDEX ON grenades (match_id, round_number);
CREATE INDEX ON grenades (type, det_place);

-- NLP semantik indeks ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE round_narratives (
    match_id     UUID,
    round_number SMALLINT,
    narrative    TEXT NOT NULL,             -- otomatik üretilen raunt anlatısı
    embedding    vector(1024),              -- bge-m3
    PRIMARY KEY (match_id, round_number)
);
CREATE INDEX ON round_narratives USING hnsw (embedding vector_cosine_ops);
```

İlişki özeti: `matches 1—N rounds`, `rounds 1—N kills / grenades / player_round_states`; `players` ve `teams` tüm olaylara referans verir; side-swap problemi raunt seviyesinde `t_team_id / ct_team_id` tutarak kökten çözülür (maç seviyesinde "takım A T'dir" varsayımı yapılmaz). Multi-tenancy, `matches.org_id` üzerinden PostgreSQL row-level security politikalarıyla uygulanır; bir organizasyonun analisti başka organizasyonun scrim verisini hiçbir sorguda göremez.

### 5.3 ClickHouse şeması (yüksek hacim)

```sql
-- Pozisyon/durum akışı: platformun kalbi ─────────────────────────────
CREATE TABLE player_ticks (
    match_id      UUID,
    map_name      LowCardinality(String),
    round_number  UInt8,
    tick          UInt32,
    round_time    Float32,                  -- freeze sonrası sn
    player_id     UUID,
    side          Enum8('T' = 1, 'CT' = 2),
    x Float32, y Float32, z Float32,
    yaw Float32, pitch Float32,             -- crosshair analizi için kritik
    velocity      Float32,
    health UInt8, armor UInt8,
    has_helmet UInt8,  -- kask
    active_weapon LowCardinality(String),
    is_alive Bool, is_ducking Bool, is_walking Bool, is_scoped Bool,
    flash_remaining Float32,
    place         LowCardinality(String)    -- ingest'te atanır
) ENGINE = MergeTree
PARTITION BY map_name
ORDER BY (match_id, round_number, player_id, tick);

CREATE TABLE weapon_fires (
    match_id UUID, round_number UInt8, tick UInt32, round_time Float32,
    player_id UUID, side Enum8('T'=1,'CT'=2),
    weapon LowCardinality(String),
    x Float32, y Float32, z Float32, yaw Float32, pitch Float32
) ENGINE = MergeTree
ORDER BY (match_id, round_number, tick);

CREATE TABLE damages (
    match_id UUID, round_number UInt8, tick UInt32, round_time Float32,
    attacker_id UUID, victim_id UUID,
    weapon LowCardinality(String),
    hp_damage UInt8, armor_damage UInt8,
    hitgroup Enum8('head'=1,'chest'=2,'stomach'=3,'left_arm'=4,
                   'right_arm'=5,'left_leg'=6,'right_leg'=7,'generic'=0)
) ENGINE = MergeTree
ORDER BY (match_id, round_number, tick);

CREATE TABLE grenade_trajectories (          -- 2D replay'de mermi/nade yolu çizimi
    match_id UUID, round_number UInt8,
    grenade_entity_id UInt32, type LowCardinality(String),
    tick UInt32, x Float32, y Float32, z Float32
) ENGINE = MergeTree
ORDER BY (match_id, round_number, grenade_entity_id, tick);

-- Isı haritası ön-agregatı: 1 sn zaman kovası × 16 birim ızgara ──────
CREATE MATERIALIZED VIEW heatmap_grid
ENGINE = SummingMergeTree
ORDER BY (map_name, side, time_bucket, grid_x, grid_y)
AS SELECT
    map_name, side,
    toUInt16(floor(round_time))      AS time_bucket,
    toInt16(intDiv(toInt32(x), 16))  AS grid_x,
    toInt16(intDiv(toInt32(y), 16))  AS grid_y,
    count()                          AS presence
FROM player_ticks
WHERE is_alive
GROUP BY map_name, side, time_bucket, grid_x, grid_y;
```

Filtreli ısı haritaları (takım, buy tipi, tarih aralığı) için aynı desenle takım/buy boyutları eklenmiş ikinci bir MV tutulur; arayüz yalnızca bu agregatları çeker (Bkz. §7.2).

---

## 6. Yapay Zekâ / Makine Öğrenimi Modülleri

### 6.1 NLP Arama Motoru — "Text-to-DSL" mimarisi

Hedef sorgu: *"Karşı takımın full buy turlarında Vertigo'da A rampasına ilk flaşı attığı anları listele."* Doğru mimari, bunu bir "LLM her şeyi yapsın" problemi olarak değil, **doğal dil → doğrulanmış yapılandırılmış sorgu (DSL) → SQL** çeviri problemi olarak kurmaktır. LLM yalnızca çeviri yapar; veriye asla doğrudan dokunmaz. Bu, hem halüsinasyonu yapısal olarak engeller hem de her sonucu deterministik ve tekrarlanabilir kılar.

Beş aşamalı akış:

**1. Niyet çözümleme.** Koçun cümlesi, Claude API'ye platformun JSON şemasıyla (structured output / tool-use) gönderilir; az örnekli (few-shot) prompt, alan ontolojisini içerir: buy tipleri, utility tipleri, bölge adları, zamanlama kavramları ("ilk", "erken", "son 30 saniye"), taraflar. Çıktı katı şemayla doğrulanır; şemaya uymayan çıktı reddedilip yeniden istenir.

**2. Varlık bağlama (grounding).** "A rampası" → `map_areas` alias sözlüğünden `RampA`; "full buy" → `rounds.t_buy_type = 'full'` (eşikler enrichment'ta standardize edilmiştir: takım ekipman değeri ve silah kompozisyonuna göre pistol/eco/semi/force/full sınıfları); "karşı takım" → konuşma bağlamındaki aktif rakip filtresi. Bağlanamayan varlıklar kullanıcıya netleştirme sorusu olarak döner ("A rampası mı, A merdiveni mi?").

**3. Örnek DSL çıktısı:**

```json
{
  "intent": "find_moments",
  "filters": {
    "map": "de_vertigo",
    "team_scope": { "role": "opponent", "team_id": "…" },
    "side": "T",
    "buy_type": ["full"],
    "event": {
      "type": "grenade", "grenade_type": "flash",
      "order": "first_of_type_in_round",
      "target_area": "RampA"
    }
  },
  "output": { "format": "clips", "context_seconds": [5, 8] }
}
```

**4. Deterministik yürütme.** DSL, Go tarafındaki sorgu derleyicisiyle parametrik SQL şablonlarına çevrilir. Yukarıdaki örnek, `grenades` tablosunda `type='flash' AND is_first_of_type_in_round AND det_place='RampA'` filtresinin `rounds.t_buy_type='full'` join'iyle kesişimidir — milisaniyelik bir sorgu, çünkü `is_first_of_type_in_round` ingest anında hesaplanmıştır. Genel kural: NLP motorunun karşılayabildiği her sorgu kalıbı için gereken kolonlar/indeksler enrichment aşamasına eklenir; sorgu zamanı hesap yapılmaz.

**5. Sonuç → klip.** Her eşleşme `(match_id, round_number, tick_start, tick_end)` dörtlüsü olarak döner; arayüz bunları 2D replay derin bağlantıları (deep link) olarak listeler, koç tıkladığında taktik tahtası o ana kurulmuş açılır.

**Hibrit geri düşüş (fallback):** DSL şemasının kapsamadığı serbest sorgular ("bu takım baskı altında nasıl dağılıyor?") için, enrichment'ın her raunt için ürettiği otomatik anlatı metinleri kullanılır — örnek: *"de_vertigo | T: full buy | 1:41 B'ye 3 oyuncu baskısı | 1:15 RampA'ya ilk flash (oyuncu-X) | 1:12 A execute, 2 smoke | 0:58 bomba A | sonuç: T (elimination)"*. Bu anlatılar bge-m3 ile vektörlenip pgvector'da indekslenir; semantik arama en yakın rauntları getirir ve sonuçlar "yaklaşık eşleşme" etiketiyle sunulur. Değerlendirme, koç sorgularından oluşturulan bir altın set üzerinde precision@10 ile ölçülür; yanlış çeviriler few-shot örnek havuzuna geri beslenir.

### 6.2 Predictive Anti-Strat — iki aşamalı tahmin sistemi

"%70 ihtimalle B rush" diyebilmek için önce "B rush"ın ne olduğunu makinenin öğrenmesi gerekir. Sistem bu yüzden iki aşamalıdır.

**Aşama 1 — Denetimsiz strateji taksonomisi.** Her rauntun ilk 25-40 saniyesi, taraf bazında bir "yaklaşım imzasına" dönüştürülür: 5 saniyelik pencerelerde bölge doluluk vektörleri (hangi place'te kaç oyuncu var) + utility dizisi (tip, bölge, zaman). Bu imzalar harita+taraf bazında kümelenir (HDBSCAN; alternatif olarak küçük bir transformer autoencoder'ın embedding'i üzerinde k-means). Ortaya çıkan kümeler takımın "oyun kitabı arketipleri"dir: *B rush, A execute (yavaş), A split (connector+rampa), default→geç karar, fake B→A…* Kümeler koç arayüzünde temsilci rauntlarla gösterilir ve **insan döngüde (human-in-the-loop)** isimlendirilir — koçun etiketlediği isimler ürünün dilidir. Küme kimliği `rounds.t_strategy_cluster` alanına yazılır.

**Aşama 2 — Sonraki raunt tahmini.** Girdi öznitelikleri: harita, raunt numarası, skor, her iki takımın tahmini buy'ı (para + loss bonus durumundan türetilir), önceki 1-3 rauntun sonucu ve strateji kümesi, mola (timeout) alınıp alınmadığı, hayatta kalan/save edilen silahlar, rakibin son 20 maçtaki küme frekansları (üstel zaman ağırlıklı — 2 hafta önceki maç dünkü scrimden daha az sayılır). Model: harita başına LightGBM çok sınıflı sınıflandırıcı; çıktı, strateji kümeleri üzerinde olasılık dağılımıdır ve **isotonic regression ile kalibre edilir** — kalibrasyonsuz bir "%70", koça verilebilecek en tehlikeli sayıdır.

**Veri azlığı gerçeği ve hiyerarşik çözüm.** 20 maç, harita başına çoğu zaman 50-100 T rauntu demektir; takım-özel bir modeli tek başına eğitmeye yetmez. Çözüm hiyerarşiktir: lig genelindeki on binlerce raunttan öğrenilen genel model, takım-özel gözlemlerle Bayesçi büzülme (shrinkage) üzerinden harmanlanır:

```
p_takım(küme) = (n · f_takım + k · p_lig) / (n + k)      k ≈ 15-30 (doğrulamayla ayarlanır)
```

Böylece 5 rauntluk kanıtla model lig ortalamasına yakın ve temkinli konuşur; 80 rauntluk kanıtla takıma özgüleşir. Maç sırasında ayrıca **çevrimiçi güncelleme** çalışır: rakip o maçta bir kümeyi beklenenden sık oynuyorsa dağılım her raunt sonunda yeniden harmanlanır ve tahmin < 100 ms'de WebSocket ile koç paneline itilir. Değerlendirme log-loss/Brier skoru + top-1/top-2 isabet ile, zamansal bölünmüş doğrulama setinde (geleceğe sızıntı yok) yapılır; taban çizgisi, takımın basit küme frekansıdır — model bunu geçemiyorsa gösterilmez.

### 6.3 Otomatik Anomali ve Mikro Hata Tespiti

Temel içgörü (§1'de belirtildiği gibi): demo verisi her tick'te kesin bakış açıları içerdiğinden bu modül CV değil, **geometri + istatistik** modülüdür. Üç metrik ailesi:

**Crosshair placement.** (a) *Angajman açılış hatası:* iki oyuncu arasında görüş hattı ilk kurulduğu tick'te, saldıranın bakış vektörü ile kurbanın kafa noktasına giden vektör arasındaki açısal fark (derece). Öldürmeye giden süre, bu açının kapatılma hızıyla "reaksiyon + düzeltme" bileşenlerine ayrıştırılır. (b) *Pre-aim disiplini:* oyuncu bir koridorda ilerlerken crosshair'inin, o bölgede tarihsel olarak düşman görülen noktaların (ısı haritasından türetilen "muhtemel kafa pozisyonları") en yakınına açısal uzaklığı ve kafa hizası düzleminden dikey sapması. Bunlar rol, harita ve bölge bazında normalize edilir — bir AWP'cinin off-angle tutması hata değildir.

**Trade metrikleri.** Her ölüm için: ölüm anında N saniye (varsayılan 5, yapılandırılabilir) içinde katile görüş hattı kurabilecek konumda bir takım arkadaşı var mıydı (*tradeable death*), varsa trade gerçekleşme süresi (`kills.trade_time_ms`), yoksa *untradeable death* sayılır. Oyuncu bazında "trade edilebilir pozisyon alma oranı" ve "trade dönüştürme süresi" dağılımları çıkarılır; entry'sine 2,5 saniyede trade atamayan bir ikili, koç raporunda klip bağlantılarıyla işaretlenir.

**Utility hataları.** Takım arkadaşını flash'lama, execute'tan geç gelen molly, boşluklu smoke duvarı — hepsi `grenades` + pozisyon kesişiminden deterministik hesaplanır.

Modelleme katmanı iki seviyelidir: (1) *Kural/eşik tabanlı bayraklar* — profesyonel korpustan (100+ maç) rol bazında yüzdelik dağılımlar çıkarılır; bir oyuncunun haftalık metriği kendi geçmişine göre sağlam z-skoru ile |z| > 1,5 saptığında veya lig p20'sinin altına düştüğünde işaretlenir. (2) *Denetimsiz anomali* — oyuncu-raunt öznitelik vektörleri üzerinde Isolation Forest, kural setinin öngörmediği sapmaları ("bu hafta B anchor rotasyonları 1,8 sn gecikmeli") yakalar. Her bayrak, kanıt klipleriyle (en kötü 5 örnek, derin bağlantı) birlikte sunulur; koçun "yanlış alarm" geri bildirimi etiket deposuna akar ve eşikler kişiselleşir. Opsiyonel CV modülü (YOLO tabanlı HUD/killfeed okuma) yalnızca demo dosyası bulunmayan video kaynakları için yol haritasının sonundadır.

---

## 7. AI Entegrasyon Yol Haritası (Eğitim Verisi ve Pipeline)

### 7.1 Veri ve eğitim hattı

Tüm ML işleri Dagster üzerinde "varlık" (asset) olarak tanımlanır; her varlık girdi verisinin hangi sürümünden üretildiğini bilir ve backfill edilebilir:

```
raw_demos (S3) ─▶ parsed_events (CH/Parquet) ─▶ round_features (CH tablo)
                                     │                    │
                                     ▼                    ▼
                            round_narratives      strategy_clusters (haftalık
                            + embeddings (PG)     yeniden eğitim, MLflow'a kayıt)
                                                          │
                                                          ▼
                                                 next_round_predictor
                                                 (harita başına LightGBM,
                                                  kalibrasyon raporu zorunlu)
                                                          │
                                                          ▼
                                              ONNX export ─▶ Inference API (FastAPI)
```

Model yaşam döngüsü: her eğitim koşusu MLflow'a metrikleri (log-loss, Brier, kalibrasyon eğrisi, küme kararlılığı) ve veri kesitini kaydeder; üretime terfi, zamansal doğrulama setinde taban çizgiyi geçme şartına bağlıdır. Çıkarım servisi modelleri ONNX Runtime ile CPU'da koşar (bu boyuttaki modeller için GPU'ya gerek yok); GPU yalnızca embedding üretimi ve olası autoencoder eğitimi için, geçici (spot) düğümlerde kullanılır. Koç geri bildirimleri (NLP sonucu doğru muydu, anomali bayrağı isabetli miydi, tahmin tuttu mu) tek bir `feedback` tablosunda toplanır ve haftalık yeniden eğitimlerin etiket kaynağıdır.

### 7.2 Hangi model, ne kadar veriyle ayağa kalkar?

| Modül | Minimum veri | Not |
|---|---|---|
| NLP → DSL çevirisi | ~50-100 el yapımı örnek sorgu (few-shot + altın set) | LLM tabanlı olduğundan büyük korpus gerekmez; şema kapsamı belirleyicidir |
| Anlatı embedding araması | 5-10 bin raunt anlatısı | Tamamen otomatik üretilir, etiket gerekmez |
| Strateji kümeleme | Harita başına ≥ 2.000 lig rauntu | Kamusal turnuva demolarıyla soğuk başlangıç yapılır |
| Sonraki raunt tahmini | Lig geneli ≥ 50 bin raunt + takım-özel 20 maç | Hiyerarşik büzülme (§6.2) takım verisi azlığını telafi eder |
| Anomali taban çizgileri | Rol başına ≥ 100 profesyonel maç | Tek seferlik korpus; sonra oyuncunun kendi geçmişi devreye girer |

Fazlar: **F1** veri temeli (parser + şema + enrichment), **F2** NLP arama (önce DSL + kural tabanlı yürütücü — LLM'siz bile değerli — sonra LLM çeviri katmanı), **F3** kümeleme + tahmin v1, **F4** anomali motoru + koç raporları. Her faz bir öncekinin ürettiği veriye yaslanır; sıralama değiştirilemez.

---

## 8. Gelişmiş Görselleştirme Katmanı

### 8.1 2D interaktif taktik tahtası (PixiJS / WebGL)

Render mimarisi: harita radar görseli statik doku (texture) olarak alta serilir; oyuncular, bakış konileri, mermi/nade yolları ve çizim katmanı ayrı PixiJS container'larıdır. Pozisyon verisi API'den JSON olarak değil, **Arrow/Parquet olarak** iner ve tarayıcıda `parquet-wasm` ile sıfır-kopya `Float32Array`'lere çözülür — bir rauntun tamamı (~18 bin satır) tek istekte < 100 ms'de gelir ve oynatma tamamen istemci tarafında akar; "gecikmesizlik" böyle sağlanır, sunucudan kare akıtarak değil. 16 Hz örneklem, `requestAnimationFrame` döngüsünde lineer interpolasyonla 60/144 fps'e yumuşatılır; çözme işi bir Web Worker'da, render ana thread'de kalır. Zaman çubuğu, kill/utility/bomba olaylarını işaretli gösterir; NLP sonuç klipleri bu tahtaya `(match, round, tick)` derin bağlantısıyla açılır. Koçun çizim araçları (ok, alan, serbest çizim) vektör katmanı olarak JSON'da saklanır; ileride Yjs (CRDT) ile çok kullanıcılı canlı taktik oturumları eklenebilir.

### 8.2 Dinamik ısı haritaları

Sunucu, §5.3'teki `heatmap_grid` agregatından, seçili filtre setinin (harita, taraf, takım, buy tipi, tarih aralığı) **tüm 1 sn'lik zaman kovalarını tek seferde** döndürür (tipik yük: 115 kova × birkaç bin dolu hücre ≈ birkaç yüz KB). İstemci, koçun zaman aralığı kaydırıcısındaki (ör. 1:30-1:10) kovaları bir fragment shader'da toplayıp renk LUT'undan geçirir — kaydırıcı her oynatıldığında sunucuya gidilmez, deneyim tamamen anlıktır. Yoğunluk normalizasyonu raunt sayısına bölünerek yapılır ki 8 maçlık filtre ile 40 maçlık filtre karşılaştırılabilir olsun.

### 8.3 Multi-View Stacking

Aynı senaryonun (ör. "rakibin Vertigo T full buy A execute'ları") N rauntu, aynı tahtada yarı saydam katmanlar olarak üst üste oynatılır. Üç hizalama modu sunulur: raunt başlangıcına göre (mutlak zaman), bomba kurulumuna göre (execute karşılaştırması) ve ilk temasa göre (reaksiyon karşılaştırması) — koçlar için asıl değer son ikisindedir. Her katman kendi renk tonu ve iz (ghost trail) uzunluğuyla çizilir; 10 katman × 10 oyuncu bile PixiJS ParticleContainer ile tek çizim çağrısında kalır. Katman seti, NLP arama sonucundan tek tıkla oluşturulur ("bu 7 rauntu üst üste koy") — iki modülün kesişimi, platformun imza deneyimidir.

---

## 9. Servisler, Altyapı ve Güvenlik

| Servis | Dil | Sorumluluk |
|---|---|---|
| api-gateway | Go | REST + WebSocket, kimlik doğrulama (SSO/OIDC), yetkilendirme, rate limit |
| ingest-svc | Go | Upload, dedup, S3 yazımı, kaynak entegrasyonları (FACEIT API, GOTV) |
| parser-worker | Rust | .dem → Arrow → CH/PG/Parquet (KEDA ile 0-N ölçek) |
| enrichment-worker | Python | Türetilmiş metrikler, anlatılar, embedding'ler |
| stats-svc | Go | DSL→SQL derleyici, agregat sorguları, klip çözümleme |
| nlp-svc | Python | LLM çeviri, grounding, hibrit vektör arama |
| ml-inference | Python | Tahmin + anomali çıkarımı (ONNX), Redis cache |
| ml-training | Python | Dagster işleri, MLflow kaydı (zamanlanmış) |

NATS konuları: `demo.ingested`, `demo.parsed`, `demo.enriched`, `ml.cluster.assigned`, `ml.prediction.ready`, `ml.anomaly.flagged`. Tümü Kubernetes'te; gözlemlenebilirlik tarafında parse süresi, kuyruk derinliği, sorgu p95'i ve model drift (tahmin dağılımı kayması) panoları birinci günden kurulur. Güvenlik: org bazlı RLS (PG) + bucket prefix IAM izolasyonu (S3) + satır filtreli ClickHouse rol politikaları; tüm demo erişimi denetim günlüğüne (audit log) yazılır — scrim sızıntısı bu üründe varoluşsal risktir.

---

## 10. Gerçekçilik Notları ve Riskler

**Parse hızı.** "Milisaniyede parse" fiziksel olarak mümkün değildir; doğru vaat "yükledikten en geç 90 saniye sonra analize hazır, tüm sorgular anlık"tır. Bu, rakip ürünlerin de üstünde bir deneyimdir ve dürüstçe pazarlanabilir.

**Format kırılganlığı.** Valve, Source 2 demo formatını güncelleyebilir ve topluluk parser'ları geçici olarak kırılabilir. Azaltım: parser sürümleme + Parquet arşivi + iki parser'lı çapraz doğrulama (Rust birincil, Go doğrulayıcı) + oyun güncellemelerinde otomatik duman testi.

**Küçük örneklem yanılgısı.** 20 maçlık rakip verisinden çıkan "%70 B rush" tahmini, kalibrasyon ve hiyerarşik büzülme olmadan koçu yanıltır. Arayüz her tahminin yanında kanıt gücünü göstermelidir ("32 gözlem, güven: orta") — bu bir UI detayı değil, ürün etiği gereksinimidir.

**Veri kaynağı hukuku.** Takımın kendi scrim GOTV kayıtları ve resmî turnuva demoları güvenli zemindir; HLTV gibi üçüncü taraf sitelerin toplu kazınması ToS ihlalidir ve otomasyonla engellenir. Ticari veri ortaklıkları (turnuva organizatörleri, FACEIT) erken gündeme alınmalıdır.

**CV vaadi.** Crosshair/trade analizi için CV kullanmak hem gereksiz hem düşük doğruluklu olurdu; demo telemetrisi üstün kaynaktır. CV yalnızca video-only istihbarat modülü olarak, açıkça "yaklaşık" etiketiyle sunulur.

---

## 11. MVP Uygulama Planı

| Faz | Süre (yaklaşık) | Teslimatlar | Çıkış kriteri |
|---|---|---|---|
| 0 — İskelet | 3-4 hafta | docker-compose ile PG+CH+MinIO+NATS; Rust parser worker PoC; tek demo → CH akışı | 1 demo < 5 sn'de parse edilip DB'de sorgulanabiliyor |
| 1 — Çekirdek ürün | 5-6 hafta | Enrichment hattı, PG şeması, 2D replay tahtası, temel istatistik ekranları | Koç bir maçı yükleyip 90 sn içinde raunt raunt izleyebiliyor |
| 2 — Isı haritası + arama v0 | 4 hafta | heatmap_grid + shader kompozitör; DSL sorgu motoru (form arayüzüyle, LLM'siz) | Zaman kaydırmalı ısı haritası anlık; DSL 20 sorgu kalıbını karşılıyor |
| 3 — NLP + stacking | 4-5 hafta | LLM çeviri katmanı, grounding sözlüğü, altın set; Multi-View Stacking | Altın sette precision@10 ≥ 0,8; NLP→klip→stack akışı uçtan uca |
| 4 — AI v1 | 6-8 hafta | Strateji kümeleme + isimlendirme arayüzü; kalibre tahmin modeli; anomali bayrakları + koç raporu | Tahmin, zamansal test setinde frekans taban çizgisini geçiyor; ilk pilot takım haftalık rapor alıyor |

---

## Ek A — DSL şema kapsamı (v1 özet)

Filtre boyutları: `map`, `side`, `team_scope`, `player_scope`, `buy_type`, `round_number/score_state`, `date_range`, `source(scrim/official)`. Olay tipleri: `grenade` (tip, sıra, hedef bölge, zaman penceresi), `kill` (silah, first_kill, trade, bölge), `bomb` (plant/defuse, site, zaman), `presence` (bölgede ≥N oyuncu, zaman penceresi), `economy` (eşik koşulları). Çıktı biçimleri: `clips`, `rounds`, `aggregate` (sayı/oran), `heatmap_filterset`, `stack_set`. Şema, stats-svc'de tek bir JSON Schema dosyası olarak yaşar; hem LLM prompt'una hem form arayüzüne aynı kaynaktan üretilir.

### team_exec_templates (analitik #5)
İlk 25 sn'nin utility-nokta kümesi şablon anahtarıdır; ≥3 tekrar eden şablonlar site dağılımı ve kazanma oranıyla saklanır (ml/templates.py, deterministik).

### Saklama politikası (2026-07-05, ürün kararı)
Katmanlı: ham .dem (MinIO) ve tick verisi (CH player_ticks/shots) 12 ay
saklanır; sonrasında otomatik silinir (matches.tick_purged=true). PG meta
ve istatistikler SÜRESİZ kalır — leaderboard/kariyer geriye dönük bozulmaz.
Sonuç: >12 ay maçlarda replay/heatmap kapalı ("archived"); CH okuyan ml
işleri (setups/roles/rotations/flash) o maçları doğal olarak dışarıda
bırakır. RETENTION_MONTHS env (varsayılan 12; 0=kapalı). 2026-07-05: 24→12 ay (ürün kararı — 1 yıldan eski meta analitik değer taşımıyor, depolama yarıya iner).

### Kişisel veritabanı (create your own database)
Kullanıcı demoları is_private=true ile işlenir; enrichment sonunda status
'private' olur — 'ready' filtreleyen hiçbir yüzeye (arama, takımlar,
leaderboard, ml) giremez. İstemci işlenmiş rauntları IndexedDB'ye indirir,
ardından DELETE /api/v1/private/{id} sunucudaki HER izi (PG+CH+MinIO)
siler. Aynı sha kamu arşivinde zaten varsa demo yeniden işlenmez; istemci
kamu kopyasından indirir ve sunucudan silme yapılmaz (public_copy=true).
