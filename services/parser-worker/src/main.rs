//! parser-worker: NATS `demo.ingested` -> MinIO'dan .dem indir -> parse ->
//! ClickHouse `player_ticks` insert -> `demo.parsed` yayınla. (mimari.md §4.3)

mod parse;
mod pg;

use anyhow::{Context, Result};
use async_nats::jetstream::{self, consumer::PullConsumer};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tracing::{error, info, warn};
use uuid::Uuid;

const PARSER_VERSION: &str = "0.1.0";
const STREAM_NAME: &str = "DEMOS";
const CONSUMER_NAME: &str = "parser-worker";
const INSERT_CHUNK: usize = 100_000;

#[derive(Debug, Deserialize)]
struct DemoIngested {
    demo_sha256: String,
    match_id: Uuid,
    object_key: String,
    /// Kaynak dosya adı (takım adlarını içerir); matches.event_name'e yazılır
    #[serde(default)]
    source_file: Option<String>,
    /// Maç tarihi (ISO 8601; ingest dosya tarihinden türetir)
    #[serde(default)]
    played_at: Option<String>,
    /// Turnuva etiketi (backfill arşiv adından; ml-jobs takım adlarını ayıklar)
    #[serde(default)]
    tournament: Option<String>,
}

#[derive(Debug, Serialize)]
struct DemoParsed<'a> {
    event: &'a str,
    demo_sha256: &'a str,
    match_id: Uuid,
    map: &'a str,
    parser_version: &'a str,
    row_counts: RowCounts,
    duration_ms: u64,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct RowCounts {
    player_ticks: usize,
    kills: usize,
    grenades: usize,
}

struct Config {
    nats_url: String,
    s3_endpoint: String,
    s3_bucket: String,
    s3_access_key: String,
    s3_secret_key: String,
    s3_region: String,
    ch_url: String,
    ch_user: String,
    ch_password: String,
    ch_db: String,
    pg_url: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        let get = |k: &str| std::env::var(k).with_context(|| format!("env eksik: {k}"));
        Ok(Self {
            nats_url: get("NATS_URL")?,
            s3_endpoint: get("S3_ENDPOINT")?,
            s3_bucket: get("S3_BUCKET")?,
            s3_access_key: get("MINIO_ROOT_USER")?,
            s3_secret_key: get("MINIO_ROOT_PASSWORD")?,
            s3_region: std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
            ch_url: get("CLICKHOUSE_URL")?,
            ch_user: get("CLICKHOUSE_USER")?,
            ch_password: get("CLICKHOUSE_PASSWORD")?,
            ch_db: get("CLICKHOUSE_DB")?,
            pg_url: get("POSTGRES_URL")?,
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = Config::from_env()?;

    let s3 = build_s3_client(&cfg).await;
    let ch = clickhouse::Client::default()
        .with_url(&cfg.ch_url)
        .with_user(&cfg.ch_user)
        .with_password(&cfg.ch_password)
        .with_database(&cfg.ch_db);

    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&cfg.pg_url)
        .await
        .context("PostgreSQL bağlantısı")?;

    let nats = async_nats::connect(&cfg.nats_url).await?;
    let js = jetstream::new(nats);

    let stream = js
        .get_or_create_stream(jetstream::stream::Config {
            name: STREAM_NAME.to_string(),
            subjects: vec!["demo.>".to_string()],
            ..Default::default()
        })
        .await?;

    let consumer: PullConsumer = stream
        .get_or_create_consumer(
            CONSUMER_NAME,
            jetstream::consumer::pull::Config {
                durable_name: Some(CONSUMER_NAME.to_string()),
                filter_subject: "demo.ingested".to_string(),
                // dev demolar (850MB+ açılmış, uzun uzatmalar) 5 dk'yı aşabiliyor;
                // erken redelivery = aynı devi iki worker'ın çiğnemesi
                ack_wait: std::time::Duration::from_secs(1800),
                // mimari.md §4.3: 3 denemeden sonra bırak (dead-letter Faz 1+)
                max_deliver: 3,
                ..Default::default()
            },
        )
        .await?;

    info!("parser-worker hazır; demo.ingested bekleniyor ({})", cfg.nats_url);

    let mut messages = consumer.messages().await?;
    while let Some(msg) = messages.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                error!("mesaj alınamadı: {e}");
                continue;
            }
        };
        match handle_message(&cfg, &s3, &ch, &pg, &js, &msg.payload).await {
            Ok(()) => {
                if let Err(e) = msg.ack().await {
                    error!("ack başarısız: {e}");
                }
            }
            Err(e) => {
                error!("iş başarısız, NAK: {e:#}");
                let _ = msg
                    .ack_with(jetstream::AckKind::Nak(Some(
                        std::time::Duration::from_secs(30),
                    )))
                    .await;
            }
        }
    }
    Ok(())
}

async fn build_s3_client(cfg: &Config) -> aws_sdk_s3::Client {
    let creds = aws_sdk_s3::config::Credentials::new(
        &cfg.s3_access_key,
        &cfg.s3_secret_key,
        None,
        None,
        "static",
    );
    let s3_cfg = aws_sdk_s3::config::Builder::new()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .endpoint_url(&cfg.s3_endpoint)
        .region(aws_sdk_s3::config::Region::new(cfg.s3_region.clone()))
        .credentials_provider(creds)
        .force_path_style(true)
        .build();
    aws_sdk_s3::Client::from_conf(s3_cfg)
}

async fn handle_message(
    cfg: &Config,
    s3: &aws_sdk_s3::Client,
    ch: &clickhouse::Client,
    pg: &sqlx::PgPool,
    js: &jetstream::Context,
    payload: &[u8],
) -> Result<()> {
    let job: DemoIngested = serde_json::from_slice(payload).context("demo.ingested payload çözülemedi")?;
    info!(match_id = %job.match_id, key = %job.object_key, "iş alındı");

    // Kanonik match_id: aynı demo daha önce işlendiyse mevcut id korunur (§4.3
    // idempotency); CH dahil tüm yazımlar bu id ile yapılır.
    let match_id = pg::upsert_match(
        pg, job.match_id, &job.demo_sha256, &job.object_key,
        PARSER_VERSION, job.source_file.as_deref(),
        job.played_at.as_deref().filter(|s| !s.is_empty()),
        job.tournament.as_deref().filter(|s| !s.is_empty()),
    ).await?;
    if match_id != job.match_id {
        info!(canonical = %match_id, "demo daha önce işlenmiş; mevcut match_id kullanılıyor");
    }

    let result = async {
        run_pipeline(cfg, s3, ch, pg, js, &job, match_id).await
    }
    .await;
    if result.is_err() {
        let _ = pg::set_match_failed(pg, &job.demo_sha256).await;
    }
    result
}

async fn run_pipeline(
    cfg: &Config,
    s3: &aws_sdk_s3::Client,
    ch: &clickhouse::Client,
    pg: &sqlx::PgPool,
    js: &jetstream::Context,
    job: &DemoIngested,
    match_id: Uuid,
) -> Result<()> {
    let t_download = Instant::now();
    let obj = s3
        .get_object()
        .bucket(&cfg.s3_bucket)
        .key(&job.object_key)
        .send()
        .await
        .with_context(|| format!("S3 indirme hatası: {}", job.object_key))?;
    let mut bytes = obj.body.collect().await?.into_bytes();
    // sıkıştırılmış ham demo (raw/<sha>.dem.zst) — depolama ~%45 küçülür
    if job.object_key.ends_with(".zst") {
        let t_dec = Instant::now();
        let decoded = tokio::task::block_in_place(|| zstd::stream::decode_all(&bytes[..]))
            .context("zstd açma hatası")?;
        info!(
            packed = bytes.len(),
            unpacked = decoded.len(),
            ms = t_dec.elapsed().as_millis() as u64,
            "demo zstd açıldı"
        );
        bytes = decoded.into();
    }
    info!(
        bytes = bytes.len(),
        ms = t_download.elapsed().as_millis() as u64,
        "demo indirildi"
    );

    // Parse CPU-yoğun; tokio runtime'ını bloklamamak için ayrı thread'de
    let t_parse = Instant::now();
    let result = tokio::task::spawn_blocking(move || parse::parse_demo_bytes(&bytes, match_id))
        .await
        .context("parse görevi çöktü")??;
    let parse_ms = t_parse.elapsed().as_millis() as u64;
    info!(
        rows = result.rows.len(),
        map = %result.map_name,
        ms = parse_ms,
        "parse tamam"
    );
    for w in &result.warnings {
        warn!("parse uyarısı: {w}");
    }

    let t_insert = Instant::now();
    // Yeniden işleme güvenli: aynı match_id'nin eski tick satırları temizlenir
    ch.query(&format!(
        "DELETE FROM player_ticks WHERE match_id = '{}'",
        match_id
    ))
    .execute()
    .await
    .context("CH eski satır temizliği")?;
    for chunk in result.rows.chunks(INSERT_CHUNK) {
        let mut insert = ch.insert("player_ticks")?;
        for row in chunk {
            insert.write(row).await?;
        }
        insert.end().await?;
    }
    // Silah atışları (ateş animasyonu) — idempotent
    ch.query(&format!("DELETE FROM shots WHERE match_id = '{}'", match_id))
        .execute()
        .await
        .context("CH shots temizliği")?;
    for chunk in result.shots.chunks(INSERT_CHUNK) {
        let mut insert = ch.insert("shots")?;
        for row in chunk {
            insert.write(row).await?;
        }
        insert.end().await?;
    }
    info!(
        shots = result.shots.len(),
        ms = t_insert.elapsed().as_millis() as u64,
        "ClickHouse insert tamam"
    );

    let t_pg = Instant::now();
    pg::write_metadata(pg, match_id, &result).await?;
    info!(
        rounds = result.rounds.len(),
        kills = result.kills.len(),
        grenades = result.grenades.len(),
        prs = result.player_rounds.len(),
        ms = t_pg.elapsed().as_millis() as u64,
        "PG meta veri yazıldı"
    );

    let parsed = DemoParsed {
        event: "demo.parsed",
        demo_sha256: &job.demo_sha256,
        match_id,
        map: &result.map_name,
        parser_version: PARSER_VERSION,
        row_counts: RowCounts {
            player_ticks: result.rows.len(),
            kills: result.kills.len(),
            grenades: result.grenades.len(),
        },
        duration_ms: parse_ms,
        warnings: result.warnings.clone(),
    };
    js.publish("demo.parsed", serde_json::to_vec(&parsed)?.into())
        .await?
        .await?;
    info!(match_id = %match_id, "demo.parsed yayınlandı");
    Ok(())
}
