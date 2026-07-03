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
    )
