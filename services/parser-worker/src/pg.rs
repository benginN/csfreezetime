//! PostgreSQL meta veri yazımı (mimari.md §4.3 adım 7, şema §5.2).

use crate::parse::{player_uuid, ParseResult};
use anyhow::{Context, Result};
use sqlx::PgPool;
use uuid::Uuid;

/// infra/postgres/schema.sql'deki seed org (Faz 1 tek-org kurulum).
pub const DEFAULT_ORG: Uuid = Uuid::from_u128(1);

/// Maçı sha256 üzerinden upsert eder ve kanonik match_id'yi döndürür.
/// Aynı demo daha önce işlendiyse mevcut match_id korunur (idempotency, §4.3);
/// tüm CH/PG yazımları bu kanonik id ile yapılmalıdır.
pub async fn upsert_match(
    pool: &PgPool,
    proposed_match_id: Uuid,
    demo_sha256: &str,
    object_key: &str,
    parser_version: &str,
    source_file: Option<&str>,
) -> Result<Uuid> {
    let (match_id,): (Uuid,) = sqlx::query_as(
        r#"
        INSERT INTO matches (match_id, org_id, demo_sha256, demo_object_key, parser_version, status, event_name)
        VALUES ($1, $2, $3, $4, $5, 'parsing', $6)
        ON CONFLICT (demo_sha256) DO UPDATE
            SET status = 'parsing', parser_version = EXCLUDED.parser_version,
                event_name = COALESCE(EXCLUDED.event_name, matches.event_name)
        RETURNING match_id
        "#,
    )
    .bind(proposed_match_id)
    .bind(DEFAULT_ORG)
    .bind(demo_sha256)
    .bind(object_key)
    .bind(parser_version)
    .bind(source_file)
    .fetch_one(pool)
    .await
    .context("matches upsert")?;
    Ok(match_id)
}

pub async fn set_match_failed(pool: &PgPool, demo_sha256: &str) -> Result<()> {
    sqlx::query("UPDATE matches SET status = 'failed' WHERE demo_sha256 = $1")
        .bind(demo_sha256)
        .execute(pool)
        .await?;
    Ok(())
}

/// Rauntları, kill/grenade olaylarını ve player_round_states'i tek
/// transaction'da yazar; eski çocuk satırları silinir (yeniden işleme güvenli).
pub async fn write_metadata(pool: &PgPool, match_id: Uuid, result: &ParseResult) -> Result<()> {
    let mut tx = pool.begin().await.context("tx begin")?;

    // Bilinmeyen harita için placeholder satır (FK; gerçek radar meta Faz 2)
    sqlx::query(
        "INSERT INTO maps (map_name, radar_pos_x, radar_pos_y, radar_scale)
         VALUES ($1, 0, 0, 1) ON CONFLICT (map_name) DO NOTHING",
    )
    .bind(&result.map_name)
    .execute(&mut *tx)
    .await?;

    // Oyuncular: roster + player_rounds'ta görülen herkes
    for p in &result.players {
        sqlx::query(
            "INSERT INTO players (player_id, steam_id64, nickname)
             VALUES ($1, $2, $3)
             ON CONFLICT (steam_id64) DO UPDATE SET nickname = EXCLUDED.nickname",
        )
        .bind(player_uuid(p.steamid))
        .bind(p.steamid as i64)
        .bind(&p.name)
        .execute(&mut *tx)
        .await?;
    }
    for pr in &result.player_rounds {
        sqlx::query(
            "INSERT INTO players (player_id, steam_id64, nickname)
             VALUES ($1, $2, 'unknown') ON CONFLICT (steam_id64) DO NOTHING",
        )
        .bind(player_uuid(pr.steamid))
        .bind(pr.steamid as i64)
        .execute(&mut *tx)
        .await?;
    }

    // Yeniden işleme: eski çocuk satırlar cascade ile temizlenir
    sqlx::query("DELETE FROM rounds WHERE match_id = $1")
        .bind(match_id)
        .execute(&mut *tx)
        .await?;

    for r in &result.rounds {
        sqlx::query(
            r#"
            INSERT INTO rounds (match_id, round_number, start_tick, freeze_end_tick, end_tick,
                                winner_side, end_reason, bomb_plant_tick, bomb_site,
                                t_equip_value, ct_equip_value)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            "#,
        )
        .bind(match_id)
        .bind(r.round_number)
        .bind(r.start_tick)
        .bind(r.freeze_end_tick)
        .bind(r.end_tick)
        .bind(&r.winner_side)
        .bind(&r.end_reason)
        .bind(r.bomb_plant_tick)
        .bind(&r.bomb_site)
        .bind(r.t_equip_value)
        .bind(r.ct_equip_value)
        .execute(&mut *tx)
        .await?;
    }

    for k in &result.kills {
        sqlx::query(
            r#"
            INSERT INTO kills (match_id, round_number, tick, round_time,
                               attacker_id, victim_id, assister_id, weapon,
                               headshot, wallbang, noscope, through_smoke,
                               attacker_blind, victim_blind,
                               attacker_x, attacker_y, attacker_z,
                               victim_x, victim_y, victim_z,
                               attacker_place, victim_place)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                    $15,$16,$17,$18,$19,$20,$21,$22)
            "#,
        )
        .bind(match_id)
        .bind(k.round_number)
        .bind(k.tick)
        .bind(k.round_time)
        .bind(k.attacker_steamid.map(player_uuid))
        .bind(k.victim_steamid.map(player_uuid))
        .bind(k.assister_steamid.map(player_uuid))
        .bind(&k.weapon)
        .bind(k.headshot)
        .bind(k.wallbang)
        .bind(k.noscope)
        .bind(k.through_smoke)
        .bind(k.attacker_blind)
        .bind(k.victim_blind)
        .bind(k.attacker_pos[0])
        .bind(k.attacker_pos[1])
        .bind(k.attacker_pos[2])
        .bind(k.victim_pos[0])
        .bind(k.victim_pos[1])
        .bind(k.victim_pos[2])
        .bind(&k.attacker_place)
        .bind(&k.victim_place)
        .execute(&mut *tx)
        .await?;
    }

    for g in &result.grenades {
        sqlx::query(
            r#"
            INSERT INTO grenades (match_id, round_number, thrower_id, side, type,
                                  detonate_tick, det_x, det_y, det_z)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            "#,
        )
        .bind(match_id)
        .bind(g.round_number)
        .bind(g.thrower_steamid.map(player_uuid))
        .bind(&g.side)
        .bind(g.grenade_type)
        .bind(g.detonate_tick)
        .bind(g.det_pos[0])
        .bind(g.det_pos[1])
        .bind(g.det_pos[2])
        .execute(&mut *tx)
        .await?;
    }

    for pr in &result.player_rounds {
        sqlx::query(
            r#"
            INSERT INTO player_round_states (match_id, round_number, player_id, side,
                                             money_start, money_spent, equip_value,
                                             survived, kills, deaths, assists,
                                             damage_dealt, flash_assists)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0)
            "#,
        )
        .bind(match_id)
        .bind(pr.round_number)
        .bind(player_uuid(pr.steamid))
        .bind(&pr.side)
        .bind(pr.money_start)
        .bind(pr.money_spent)
        .bind(pr.equip_value)
        .bind(pr.survived)
        .bind(pr.kills)
        .bind(pr.deaths)
        .bind(pr.assists)
        .bind(pr.damage_dealt)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("UPDATE matches SET map_name = $2, status = 'enriching' WHERE match_id = $1")
        .bind(match_id)
        .bind(&result.map_name)
        .execute(&mut *tx)
        .await?;

    tx.commit().await.context("tx commit")?;
    Ok(())
}
