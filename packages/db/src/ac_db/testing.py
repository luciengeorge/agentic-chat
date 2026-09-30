"""A throwaway, migrated database per test session, so tests never touch dev data."""

import uuid
from collections.abc import Generator
from contextlib import contextmanager

import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

from ac_db.migrate import upgrade


def postgres_reachable(url: str) -> bool:
    try:
        with psycopg.connect(_conninfo(url), connect_timeout=2):
            return True
    except psycopg.OperationalError:
        return False


@contextmanager
def temporary_database(url: str) -> Generator[str]:
    """Create a fresh database next to `url`'s, migrate it to head, and drop it afterwards."""
    base = make_url(url)
    name = f"ac_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(_conninfo(url), autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    test_url = base.set(database=name).render_as_string(hide_password=False)
    try:
        upgrade(test_url)
        yield test_url
    finally:
        with psycopg.connect(_conninfo(url), autocommit=True) as admin:
            admin.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )


def _conninfo(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)
