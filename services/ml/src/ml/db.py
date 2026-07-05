"""Bağlantı yardımcıları — infra/.env değişkenlerinden."""

from __future__ import annotations

import os
from urllib.parse import urlparse

import clickhouse_connect
import psycopg


def pg() -> psycopg.Connection:
    return psycopg.connect(os.environ["POSTGRES_URL"])


def ch():
    url = urlparse(os.environ.get("CLICKHOUSE_URL", "http://localhost:8123"))
    return clickhouse_connect.get_client(
        host=url.hostname or "localhost",
        port=url.port or 8123,
        username=os.environ["CLICKHOUSE_USER"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
        database=os.environ["CLICKHOUSE_DB"],
        # Düşük RAM'li ortam (Colima 8GB): büyük GROUP BY'lar belleğe
        # sığmayınca diske taşsın; sorgu başına tavan da sunucu
        # limitinin (7GB) altında kalsın ki OvercommitTracker kesmesin.
        settings={
            "max_bytes_before_external_group_by": 2 * 1024**3,
            "max_bytes_before_external_sort": 2 * 1024**3,
            "max_memory_usage": 5 * 1024**3,
        },
    )
