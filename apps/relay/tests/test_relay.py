import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import AsyncEngine
from temporalio.client import WorkflowExecutionStatus
from temporalio.testing import WorkflowEnvironment

from ac_db.engine import create_direct_engine
from ac_db.models import Outbox, Tenant
from ac_relay.relay import (
    OutboxRow,
    UnknownKindError,
    WorkflowStart,
    claim,
    publish,
    relay_once,
    workflow_start,
)
from ac_workers.worker import create_worker

ROW_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


def test_hello_row_starts_hello_workflow() -> None:
    row = OutboxRow(ROW_ID, "kestrel", "hello", {"name": "smoke"})
    assert workflow_start(row) == WorkflowStart(
        "HelloWorkflow", {"name": "smoke"}, f"kestrel:hello:{ROW_ID}"
    )


def test_unknown_kind_is_refused() -> None:
    with pytest.raises(UnknownKindError):
        workflow_start(OutboxRow(ROW_ID, "kestrel", "nope", {}))


@pytest.fixture
async def env() -> AsyncIterator[WorkflowEnvironment]:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        yield env


async def test_publishing_twice_starts_one_workflow(env: WorkflowEnvironment) -> None:
    start = workflow_start(OutboxRow(uuid.uuid4(), "kestrel", "hello", {"name": "once"}))
    await publish(env.client, start)
    handle = env.client.get_workflow_handle(start.id)
    first_run = (await handle.describe()).run_id

    await publish(env.client, start)  # while running: attaches to it
    assert (await handle.describe()).run_id == first_run

    async with create_worker(env.client):
        assert await handle.result() == "hello once"
    await publish(env.client, start)  # after it closed: refused, not rerun
    description = await handle.describe()
    assert (description.run_id, description.status) == (
        first_run,
        WorkflowExecutionStatus.COMPLETED,
    )


@pytest.fixture
async def engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    engine = create_direct_engine(database_url)
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM outbox"))
    yield engine
    await engine.dispose()


async def insert_hello(engine: AsyncEngine, name: str, partition_key: str) -> uuid.UUID:
    async with engine.begin() as conn:
        tenant_id = (
            await conn.execute(select(Tenant.id).where(Tenant.slug == "kestrel"))
        ).scalar_one()
        return (
            await conn.execute(
                insert(Outbox)
                .values(
                    tenant_id=tenant_id,
                    kind="hello",
                    payload={"name": name},
                    partition_key=partition_key,
                )
                .returning(Outbox.id)
            )
        ).scalar_one()


@pytest.mark.postgres
async def test_claim_skips_locked_rows(engine: AsyncEngine) -> None:
    ids = {await insert_hello(engine, f"n{i}", f"conv-{i}") for i in range(3)}
    async with engine.begin() as first, engine.begin() as second:
        claimed = await claim(first, partition=0, partitions=1)
        assert {r.id for r in claimed} == ids
        assert await claim(second, partition=0, partitions=1) == []


@pytest.mark.postgres
async def test_partitions_split_rows_disjointly(engine: AsyncEngine) -> None:
    ids = {await insert_hello(engine, f"n{i}", f"conv-{i}") for i in range(20)}
    async with engine.begin() as conn:
        parts = [{r.id for r in await claim(conn, partition=p, partitions=3)} for p in range(3)]
    assert set().union(*parts) == ids
    assert sum(len(p) for p in parts) == len(ids)


@pytest.mark.postgres
async def test_relay_once_starts_workflow_and_marks_published(
    engine: AsyncEngine, env: WorkflowEnvironment
) -> None:
    row_id = await insert_hello(engine, "smoke", "conv-1")
    assert await relay_once(engine, env.client, partition=0, partitions=1) == 1
    async with create_worker(env.client):
        result = await env.client.get_workflow_handle(f"kestrel:hello:{row_id}").result()
    assert result == "hello smoke"
    async with engine.connect() as conn:
        published = (
            await conn.execute(select(Outbox.published_at).where(Outbox.id == row_id))
        ).scalar_one()
    assert published is not None
    assert await relay_once(engine, env.client, partition=0, partitions=1) == 0
