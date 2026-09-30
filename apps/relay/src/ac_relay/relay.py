"""Outbox to Temporal, at least once.

A batch of unpublished rows is claimed with FOR UPDATE SKIP LOCKED, so relays on
other partitions (or a stray second relay) never block on or double-claim them.
Workflows start while the row locks are held and `published_at` is set in the
same transaction. A crash in between leaves the rows unpublished, and the next
claim starts them again: the workflow id comes from the row, so the second start
lands on the same workflow.
"""

import asyncio
import contextlib
import uuid
from dataclasses import dataclass
from typing import Any

import structlog
from sqlalchemy import ColumnElement, ColumnExpressionArgument, func, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from temporalio.client import Client
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from ac_core.temporal import DEFAULT_TASK_QUEUE
from ac_db.models import Outbox, Tenant

BATCH_SIZE = 100
POLL_INTERVAL_S = 0.5

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class OutboxRow:
    id: uuid.UUID
    tenant_slug: str
    kind: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class WorkflowStart:
    workflow: str
    arg: dict[str, Any]
    id: str


class UnknownKindError(ValueError):
    pass


def workflow_start(row: OutboxRow) -> WorkflowStart:
    match row.kind:
        case "hello":
            return WorkflowStart("HelloWorkflow", row.payload, f"{row.tenant_slug}:hello:{row.id}")
        case _:
            raise UnknownKindError(f"outbox row {row.id} has unknown kind {row.kind!r}")


def partition_of(key: ColumnExpressionArgument[str], partitions: int) -> ColumnElement[int]:
    """Postgres-side partition of a key: a stable 64-bit hash, reduced mod `partitions`."""
    hashed = func.hashtextextended(key, 0)
    return func.mod(func.mod(hashed, partitions) + partitions, partitions)


async def claim(
    conn: AsyncConnection, *, partition: int, partitions: int, limit: int = BATCH_SIZE
) -> list[OutboxRow]:
    query = (
        select(Outbox.id, Tenant.slug, Outbox.kind, Outbox.payload)
        .join(Tenant, Tenant.id == Outbox.tenant_id)
        .where(
            Outbox.published_at.is_(None),
            partition_of(Outbox.partition_key, partitions) == partition,
        )
        .order_by(Outbox.created_at)
        .limit(limit)
        .with_for_update(of=Outbox, skip_locked=True)
    )
    result = await conn.execute(query)
    return [OutboxRow(id, slug, kind, payload) for id, slug, kind, payload in result]


async def publish(client: Client, start: WorkflowStart) -> None:
    try:
        await client.start_workflow(
            start.workflow,
            start.arg,
            id=start.id,
            task_queue=DEFAULT_TASK_QUEUE,
            # Running: attach to it. Closed: refuse, since this row was already delivered.
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )
    except WorkflowAlreadyStartedError:
        log.info("outbox.already_started", workflow_id=start.id)


async def relay_once(
    engine: AsyncEngine, client: Client, *, partition: int, partitions: int
) -> int:
    async with engine.begin() as conn:
        rows = await claim(conn, partition=partition, partitions=partitions)
        for row in rows:
            await publish(client, workflow_start(row))
        if rows:
            await conn.execute(
                update(Outbox)
                .where(Outbox.id.in_([row.id for row in rows]))
                .values(published_at=func.now())
            )
    if rows:
        log.info("outbox.published", count=len(rows), partition=partition)
    return len(rows)


async def run(
    engine: AsyncEngine,
    client: Client,
    stop: asyncio.Event,
    *,
    partition: int,
    partitions: int,
) -> None:
    while not stop.is_set():
        try:
            claimed = await relay_once(engine, client, partition=partition, partitions=partitions)
        except Exception:
            log.exception("outbox.relay_failed", partition=partition)
            claimed = 0
        if claimed < BATCH_SIZE:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), POLL_INTERVAL_S)
