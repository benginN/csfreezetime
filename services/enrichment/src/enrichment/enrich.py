"""Türetilmiş metrikler (mimari.md §4.3 adım 10-11, §6.3 trade tanımı).

Tüm hesaplar saf SQL ile PostgreSQL içinde yapılır; sorgu zamanı hesap
yapılmaz ilkesi gereği sonuçlar kills/rounds/grenades kolonlarına yazılır.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import psycopg

TICK_RATE = 64

# §6.3: ölüm sonrası trade penceresi (varsayılan 5 sn, yapılandırılabilir)
TRADE_WINDOW_SECONDS = float(os.environ.get("TRADE_WINDOW_SECONDS", "5"))

# §6.1: buy sınıfları takım toplam ekipman değerinden (5 kişilik taraf).
# Eşikler standardize edilmiştir; env ile ayarlanabilir.
BUY_ECO_MAX = int(os.environ.get("BUY_ECO_MAX", "5000"))
BUY_SEMI_MAX = int(os.environ.get("BUY_SEMI_MAX", "10000"))
BUY_FORCE_MAX = int(os.environ.get("BUY_FORCE_MAX", "20000"))


@dataclass
class EnrichCounts:
    first_kills: int
    trades: int
    rounds_classified: int
    first_grenades: int


async def enrich_match(conn: psycopg.AsyncConnection, match_id: str) -> EnrichCounts:
    async with conn.cursor() as cur:
        first_kills = await _mark_first_kills(cur, match_id)
        trades = await _mark_trades(cur, match_id)
        rounds_classified = await _classify_buys(cur, match_id)
        first_grenades = await _mark_first_grenades(cur, match_id)
        await cur.execute(
            """UPDATE matches SET status =
                   CASE WHEN is_private THEN 'private' ELSE 'ready' END
               WHERE match_id = %s""", (match_id,)
        )
    await conn.commit()
    return EnrichCounts(first_kills, trades, rounds_classified, first_grenades)


async def _mark_first_kills(cur: psycopg.AsyncCursor, match_id: str) -> int:
    await cur.execute(
        "UPDATE kills SET is_first_kill = FALSE WHERE match_id = %s", (match_id,)
    )
    await cur.execute(
        """
        UPDATE kills SET is_first_kill = TRUE
        WHERE kill_id IN (
            SELECT DISTINCT ON (round_number) kill_id
            FROM kills WHERE match_id = %s
            ORDER BY round_number, tick, kill_id
        )
        """,
        (match_id,),
    )
    return cur.rowcount


async def _mark_trades(cur: psycopg.AsyncCursor, match_id: str) -> int:
    """Kill K bir trade'dir <=> K'nin kurbanı V, K'den önceki pencere içinde
    K'nin saldırganının takım arkadaşını öldürmüştür (§6.3). Taraflar raunt
    bazında player_round_states'ten çözülür (side-swap güvenli)."""
    await cur.execute(
        "UPDATE kills SET is_trade = FALSE, trade_time_ms = NULL WHERE match_id = %s",
        (match_id,),
    )
    window_ticks = int(TRADE_WINDOW_SECONDS * TICK_RATE)
    await cur.execute(
        """
        WITH sides AS (
            SELECT player_id, round_number, side
            FROM player_round_states WHERE match_id = %(mid)s
        ),
        trades AS (
            SELECT k.kill_id, MIN(k.tick - p.tick) AS dt_ticks
            FROM kills k
            JOIN kills p
              ON p.match_id = k.match_id
             AND p.round_number = k.round_number
             AND p.attacker_id = k.victim_id      -- kurban, az önce öldüren kişi
             AND p.kill_id <> k.kill_id
             AND p.tick <= k.tick
             AND k.tick - p.tick <= %(win)s
            JOIN sides sa ON sa.player_id = k.attacker_id
                         AND sa.round_number = k.round_number
            JOIN sides sw ON sw.player_id = p.victim_id
                         AND sw.round_number = k.round_number
            WHERE k.match_id = %(mid)s
              AND k.attacker_id IS NOT NULL
              AND sa.side = sw.side               -- ölen, trade atanın takım arkadaşı
              AND p.victim_id <> k.attacker_id
            GROUP BY k.kill_id
        )
        UPDATE kills k
        SET is_trade = TRUE,
            trade_time_ms = (t.dt_ticks * 1000) / %(tick_rate)s
        FROM trades t
        WHERE k.kill_id = t.kill_id
        """,
        {"mid": match_id, "win": window_ticks, "tick_rate": TICK_RATE},
    )
    return cur.rowcount


async def _classify_buys(cur: psycopg.AsyncCursor, match_id: str) -> int:
    await cur.execute(
        """
        UPDATE rounds SET
            t_buy_type = CASE
                WHEN round_number IN (1, 13) THEN 'pistol'
                WHEN t_equip_value IS NULL THEN NULL
                WHEN t_equip_value < %(eco)s THEN 'eco'
                WHEN t_equip_value < %(semi)s THEN 'semi'
                WHEN t_equip_value < %(force)s THEN 'force'
                ELSE 'full'
            END,
            ct_buy_type = CASE
                WHEN round_number IN (1, 13) THEN 'pistol'
                WHEN ct_equip_value IS NULL THEN NULL
                WHEN ct_equip_value < %(eco)s THEN 'eco'
                WHEN ct_equip_value < %(semi)s THEN 'semi'
                WHEN ct_equip_value < %(force)s THEN 'force'
                ELSE 'full'
            END
        WHERE match_id = %(mid)s
        """,
        {"mid": match_id, "eco": BUY_ECO_MAX, "semi": BUY_SEMI_MAX, "force": BUY_FORCE_MAX},
    )
    return cur.rowcount


async def _mark_first_grenades(cur: psycopg.AsyncCursor, match_id: str) -> int:
    await cur.execute(
        "UPDATE grenades SET is_first_of_type_in_round = FALSE WHERE match_id = %s",
        (match_id,),
    )
    await cur.execute(
        """
        UPDATE grenades SET is_first_of_type_in_round = TRUE
        WHERE grenade_id IN (
            SELECT DISTINCT ON (round_number, type) grenade_id
            FROM grenades WHERE match_id = %s
            ORDER BY round_number, type, detonate_tick, grenade_id
        )
        """,
        (match_id,),
    )
    return cur.rowcount
