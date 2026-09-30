import pytest
from sqlalchemy import text

from ac_db.engine import create_direct_engine, create_pooled_engine

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
