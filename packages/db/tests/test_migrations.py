import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, text

from ac_db.engine import create_direct_engine, create_pooled_engine
from ac_db.models import Base

pytestmark = pytest.mark.postgres


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


def test_models_match_the_migrations(database_url: str) -> None:
    engine = create_engine(database_url)
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    engine.dispose()
    assert diff == []
