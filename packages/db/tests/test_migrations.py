from collections.abc import Iterator
from typing import Any

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, create_engine, text

from ac_db.engine import create_direct_engine, create_pooled_engine
from ac_db.models import Base
from ac_db.testing import temporary_database

pytestmark = pytest.mark.postgres

# compare_metadata skips CHECK constraints, index predicates, sequences and triggers, so `drift`
# also compares these catalog rows against a database built from the models.
CATALOG = (
    """
    SELECT 'column', c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid)
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND c.relname <> 'alembic_version' AND a.attnum > 0 AND NOT a.attisdropped
    """,
    """
    SELECT 'constraint', conrelid::regclass::text, conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'alembic_version'
    """,
    """
    SELECT 'index', tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename <> 'alembic_version'
    """,
    """
    SELECT 'sequence', sequencename, data_type::text, start_value, increment_by, min_value,
           max_value, cycle, cache_size
    FROM pg_sequences WHERE schemaname = 'public'
    """,
    """
    SELECT 'trigger', c.relname, t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
    """,
)


@pytest.fixture(scope="module")
def models_url(database_url: str) -> Iterator[str]:
    """A database built from the models alone, for `drift` to compare against."""
    with temporary_database(database_url, migrate=False) as url:
        engine = create_engine(url)
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            Base.metadata.create_all(conn)
        engine.dispose()
        yield url


def catalog(conn: Connection) -> set[tuple[Any, ...]]:
    return {tuple(row) for query in CATALOG for row in conn.execute(text(query))}


def drift(url: str, models_url: str) -> list[Any]:
    """How the migrated database at `url` differs from `ac_db.models`."""
    engine = create_engine(url)
    with engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"compare_server_default": True})
        diff: list[Any] = compare_metadata(context, Base.metadata)
        migrated = catalog(conn)
    engine.dispose()
    engine = create_engine(models_url)
    with engine.connect() as conn:
        modelled = catalog(conn)
    engine.dispose()
    return [
        *diff,
        *(("only in the migrations", *row) for row in sorted(migrated - modelled, key=str)),
        *(("only in the models", *row) for row in sorted(modelled - migrated, key=str)),
    ]


async def test_tenants_are_seeded(database_url: str) -> None:
    engine = create_direct_engine(database_url)
    async with engine.connect() as conn:
        slugs = (await conn.execute(text("SELECT slug FROM tenants ORDER BY slug"))).scalars()
        assert list(slugs) == ["harbour", "kestrel"]
    await engine.dispose()


async def test_outbox_rls_is_enabled_not_forced(database_url: str) -> None:
    engine = create_direct_engine(database_url)
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                    "WHERE relname = 'outbox'"
                )
            )
        ).one()
    assert tuple(row) == (True, False)
    await engine.dispose()


async def test_pooled_engine_never_prepares(database_url: str) -> None:
    engine = create_pooled_engine(database_url)
    async with engine.connect() as conn:
        for _ in range(10):
            await conn.execute(text("SELECT 1"))
        raw = await conn.get_raw_connection()
        assert raw.driver_connection.prepare_threshold is None  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue, reportUnknownMemberType]
        prepared = (
            await conn.execute(text("SELECT count(*) FROM pg_prepared_statements"))
        ).scalar()
    assert prepared == 0
    await engine.dispose()


@pytest.mark.parametrize("setting", [None, ""])
async def test_rls_policy_tolerates_an_unset_tenant(database_url: str, setting: str | None) -> None:
    """`SET LOCAL` leaves the GUC as '' for the rest of the session, which mustn't break queries.

    The policy is evaluated directly because a superuser (CI's role) bypasses RLS even when forced.
    """
    engine = create_direct_engine(database_url)
    async with engine.connect() as conn:
        qual = (
            await conn.execute(
                text(
                    "SELECT qual FROM pg_policies "
                    "WHERE tablename = 'outbox' AND policyname = 'tenant_isolation'"
                )
            )
        ).scalar_one()
        if setting is not None:
            await conn.execute(
                text("SELECT set_config('app.tenant_id', :v, false)"), {"v": setting}
            )
        visible = (
            await conn.execute(
                text(f"SELECT {qual} FROM (SELECT gen_random_uuid() AS tenant_id) t")
            )
        ).scalar_one()
    assert visible is None  # no tenant set: the row matches nothing
    await engine.dispose()


def test_models_match_the_migrations(database_url: str, models_url: str) -> None:
    assert drift(database_url, models_url) == []


@pytest.mark.parametrize(
    ("mutation", "name"),
    [
        pytest.param(
            ["ALTER TABLE documents DROP CONSTRAINT documents_status_check"],
            "documents_status_check",
            id="dropped-check",
        ),
        pytest.param(
            ["ALTER TABLE documents ALTER COLUMN acl_version DROP DEFAULT"],
            "acl_version",
            id="dropped-default",
        ),
        pytest.param(
            [
                "DROP INDEX outbox_pending_idx",
                "CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE published_at IS NULL",
            ],
            "outbox_pending_idx",
            id="changed-index-predicate",
        ),
        pytest.param(["DROP SEQUENCE acl_version_seq"], "acl_version_seq", id="dropped-sequence"),
        pytest.param(
            ["ALTER SEQUENCE acl_version_seq CACHE 20"], "acl_version_seq", id="sequence-cache"
        ),
        pytest.param(
            [
                "CREATE FUNCTION keep_row() RETURNS trigger LANGUAGE plpgsql"
                " AS $$ BEGIN RETURN NEW; END $$",
                "CREATE TRIGGER documents_keep_row BEFORE UPDATE ON documents"
                " FOR EACH ROW EXECUTE FUNCTION keep_row()",
            ],
            "documents_keep_row",
            id="added-trigger",
        ),
    ],
)
def test_drift_check_catches(
    database_url: str, models_url: str, mutation: list[str], name: str
) -> None:
    with temporary_database(database_url) as url:
        engine = create_engine(url)
        with engine.begin() as conn:
            for statement in mutation:
                conn.execute(text(statement))
        engine.dispose()
        found = drift(url, models_url)
    assert found
    assert name in str(found)
