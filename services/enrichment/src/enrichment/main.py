"""enrichment-worker: NATS demo.parsed -> türetilmiş metrikler -> demo.enriched.

Rust parser-worker ile aynı kuyruk semantiği: DEMOS stream'i üzerinde durable
pull consumer, 3 deneme, başarısızlıkta 30 sn gecikmeli NAK.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import asdict

import nats
import psycopg
from nats.js.api import AckPolicy, ConsumerConfig, StreamConfig
from nats.js.errors import NotFoundError

from .enrich import enrich_match

log = logging.getLogger("enrichment")

STREAM = "DEMOS"
DURABLE = "enrichment-worker"
NAK_DELAY_SECONDS = 30


def env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"env eksik: {key}")
    return value


async def handle(js, pg_url: str, msg) -> None:
    payload = json.loads(msg.data)
    match_id = payload["match_id"]
    log.info("iş alındı match_id=%s map=%s", match_id, payload.get("map"))

    async with await psycopg.AsyncConnection.connect(pg_url) as conn:
        counts = await enrich_match(conn, match_id)

    log.info(
        "enrichment tamam match_id=%s first_kills=%d trades=%d rounds=%d first_grenades=%d",
        match_id, counts.first_kills, counts.trades,
        counts.rounds_classified, counts.first_grenades,
    )
    await js.publish(
        "demo.enriched",
        json.dumps(
            {
                "event": "demo.enriched",
                "match_id": match_id,
                "demo_sha256": payload.get("demo_sha256"),
                "updated": asdict(counts),
            }
        ).encode(),
    )
    log.info("demo.enriched yayınlandı match_id=%s", match_id)


async def run() -> None:
    nats_url = env("NATS_URL")
    pg_url = env("POSTGRES_URL")

    nc = await nats.connect(nats_url)
    js = nc.jetstream()
    try:
        await js.stream_info(STREAM)
    except NotFoundError:
        await js.add_stream(StreamConfig(name=STREAM, subjects=["demo.>"]))

    sub = await js.pull_subscribe(
        "demo.parsed",
        durable=DURABLE,
        config=ConsumerConfig(
            durable_name=DURABLE,
            filter_subject="demo.parsed",
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=120,
            max_deliver=3,
        ),
    )
    log.info("enrichment-worker hazır; demo.parsed bekleniyor (%s)", nats_url)

    while True:
        try:
            msgs = await sub.fetch(1, timeout=30)
        except nats.errors.TimeoutError:
            continue
        for msg in msgs:
            try:
                await handle(js, pg_url, msg)
                await msg.ack()
            except Exception:
                log.exception("iş başarısız, NAK")
                await msg.nak(delay=NAK_DELAY_SECONDS)


def cli() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    asyncio.run(run())


if __name__ == "__main__":
    cli()
