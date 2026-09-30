import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, cast

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import AsyncEngine
from temporalio.client import Client, WorkflowExecutionStatus
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
    row = OutboxRow(ROW_ID, "kestrel", "hello", {"name": "smoke"}, "conv-1", 0)
    assert workflow_start(row) == WorkflowStart(
        "HelloWorkflow", {"name": "smoke"}, f"kestrel:hello:{ROW_ID}"
    )


def test_unknown_kind_is_refused() -> None:
    with pytest.raises(UnknownKindError):
        workflow_start(OutboxRow(ROW_ID, "kestrel", "nope", {}, "conv-1", 0))


@pytest.fixture
async def env() -> AsyncIterator[WorkflowEnvironment]:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        yield env


async def test_publishing_twice_starts_one_workflow(env: WorkflowEnvironment) -> None:
    start = workflow_start(OutboxRow(uuid.uuid4(), "kestrel", "hello", {"name": "once"}, "c", 0))
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
    return await insert_row(engine, "hello", {"name": name}, partition_key)


async def insert_row(
    engine: AsyncEngine, kind: str, payload: dict[str, Any], partition_key: str
) -> uuid.UUID:
    async with engine.begin() as conn:
        tenant_id = (
            await conn.execute(select(Tenant.id).where(Tenant.slug == "kestrel"))
        ).scalar_one()
        return (
            await conn.execute(
                insert(Outbox)
                .values(
                    tenant_id=tenant_id,
                    kind=kind,
                    payload=payload,
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


@dataclass
class FakeClient:
    """Stands in for Temporal: records starts, fails the ids in `failing`, and can hold a start."""

    failing: dict[str, Exception] = field(default_factory=dict[str, Exception])
    hold: asyncio.Event | None = None
    holding: asyncio.Event = field(default_factory=asyncio.Event)
    started: list[str] = field(default_factory=list[str])

    async def start_workflow(self, workflow: str, arg: object, *, id: str, **_: object) -> None:
        if self.hold is not None and not self.holding.is_set():
            self.holding.set()
            await self.hold.wait()
        if id in self.failing:
            raise self.failing[id]
        self.started.append(id)

    @property
    def client(self) -> Client:
        return cast(Client, self)


async def outbox_row(engine: AsyncEngine, row_id: uuid.UUID) -> dict[str, Any]:
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                select(
                    Outbox.published_at, Outbox.attempts, Outbox.last_error, Outbox.failed_at
                ).where(Outbox.id == row_id)
            )
        ).one()
    return dict(row._mapping)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.postgres
async def test_a_bad_row_does_not_block_the_next(engine: AsyncEngine) -> None:
    bad = await insert_row(engine, "nope", {}, "conv-1")
    good = await insert_hello(engine, "smoke", "conv-1")
    fake = FakeClient()

    assert await relay_once(engine, fake.client, partition=0, partitions=1) == 2

    assert fake.started == [f"kestrel:hello:{good}"]
    assert (await outbox_row(engine, good))["published_at"] is not None
    failed = await outbox_row(engine, bad)
    assert failed["published_at"] is None
    assert failed["failed_at"] is not None  # an unknown kind never gets better: no retries
    assert failed["attempts"] == 1
    assert "unknown kind 'nope'" in failed["last_error"]
    assert await relay_once(engine, fake.client, partition=0, partitions=1) == 0


@pytest.mark.postgres
async def test_a_failing_row_is_retried_then_given_up(engine: AsyncEngine) -> None:
    row_id = await insert_hello(engine, "smoke", "conv-1")
    fake = FakeClient(failing={f"kestrel:hello:{row_id}": RuntimeError("temporal hiccup")})

    assert await relay_once(engine, fake.client, partition=0, partitions=1, max_attempts=2) == 1
    first = await outbox_row(engine, row_id)
    assert (first["attempts"], first["failed_at"]) == (1, None)
    assert first["last_error"] == "RuntimeError: temporal hiccup"

    assert await relay_once(engine, fake.client, partition=0, partitions=1, max_attempts=2) == 1
    second = await outbox_row(engine, row_id)
    assert second["attempts"] == 2
    assert second["failed_at"] is not None
    assert await relay_once(engine, fake.client, partition=0, partitions=1, max_attempts=2) == 0


@pytest.mark.postgres
async def test_a_retrying_row_holds_back_later_rows_for_its_key(engine: AsyncEngine) -> None:
    stuck = await insert_hello(engine, "first", "conv-1")
    same_key = await insert_hello(engine, "second", "conv-1")
    other_key = await insert_hello(engine, "other", "conv-2")
    fake = FakeClient(failing={f"kestrel:hello:{stuck}": RuntimeError("hiccup")})

    await relay_once(engine, fake.client, partition=0, partitions=1)

    assert fake.started == [f"kestrel:hello:{other_key}"]
    assert (await outbox_row(engine, same_key))["published_at"] is None


@pytest.mark.postgres
async def test_one_relay_at_a_time_per_partition(engine: AsyncEngine) -> None:
    """Relay A holds an earlier row for a key; relay B must not publish a later one past it."""
    earlier = await insert_hello(engine, "earlier", "conv-1")
    fake = FakeClient(hold=asyncio.Event())
    relay_a = asyncio.create_task(relay_once(engine, fake.client, partition=0, partitions=1))
    await asyncio.wait_for(fake.holding.wait(), 5)

    later = await insert_hello(engine, "later", "conv-1")
    assert await relay_once(engine, fake.client, partition=0, partitions=1) == 0
    assert (await outbox_row(engine, later))["published_at"] is None

    fake.hold.set()  # pyright: ignore[reportOptionalMemberAccess]
    assert await relay_a == 1
    assert await relay_once(engine, fake.client, partition=0, partitions=1) == 1
    assert fake.started == [f"kestrel:hello:{earlier}", f"kestrel:hello:{later}"]
