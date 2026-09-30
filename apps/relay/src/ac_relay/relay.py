"""Outbox to Temporal, at least once, in order per partition key.

Each batch runs in one transaction that first takes the partition's advisory
lock, so a partition has one owner at a time: with SKIP LOCKED alone, a second
relay could publish a later row for a key while the first still holds an earlier
one. The batch is claimed with FOR UPDATE SKIP LOCKED, workflows start while the
row locks are held, and `published_at` is set in the same transaction. A crash
in between leaves the rows unpublished, and the next claim starts them again:
the workflow id comes from the row, so the second start lands on the same
workflow.

Rows fail one at a time. A failed start counts an attempt and holds back the
later rows for its key until it succeeds or runs out of attempts; then it gets
`failed_at` and is never claimed again. An unknown kind fails at once. Temporal
being down or overloaded isn't the row's fault: that aborts the batch and rolls
it back without counting anything, and the rows go out once Temporal is back.
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
from temporalio.service import RPCError, RPCStatusCode

from ac_core.temporal import DEFAULT_TASK_QUEUE
from ac_db.models import Outbox, Tenant

BATCH_SIZE = 100
POLL_INTERVAL_S = 0.5
DEFAULT_MAX_ATTEMPTS = 5
# The first key of the two-int advisory lock, so relay partition locks can't collide with others.
PARTITION_LOCK_SPACE = 0x0AC0

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class OutboxRow:
    id: uuid.UUID
    tenant_slug: str
    kind: str
    payload: dict[str, Any]
    partition_key: str
    attempts: int


@dataclass(frozen=True)
class WorkflowStart:
    workflow: str
    arg: dict[str, Any]
    id: str


class UnknownKindError(ValueError):
    pass


OUTAGE_STATUSES = frozenset(
    {RPCStatusCode.UNAVAILABLE, RPCStatusCode.DEADLINE_EXCEEDED, RPCStatusCode.RESOURCE_EXHAUSTED}
)


def is_outage(error: Exception) -> bool:
    """Temporal unreachable or overloaded: it says nothing about the row being published."""
    if isinstance(error, RPCError):
        return error.status in OUTAGE_STATUSES
    return isinstance(error, (ConnectionError, TimeoutError))


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
        select(
            Outbox.id,
            Tenant.slug,
            Outbox.kind,
            Outbox.payload,
            Outbox.partition_key,
            Outbox.attempts,
        )
        .join(Tenant, Tenant.id == Outbox.tenant_id)
        .where(
            Outbox.published_at.is_(None),
            Outbox.failed_at.is_(None),
            partition_of(Outbox.partition_key, partitions) == partition,
        )
        .order_by(Outbox.created_at)
        .limit(limit)
        .with_for_update(of=Outbox, skip_locked=True)
    )
    result = await conn.execute(query)
    return [OutboxRow(*row) for row in result]


async def own_partition(conn: AsyncConnection, partition: int) -> bool:
    """Try the partition's lock for the rest of this transaction. False: another relay has it."""
    locked = await conn.scalar(
        select(func.pg_try_advisory_xact_lock(PARTITION_LOCK_SPACE, partition))
    )
    return bool(locked)


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


async def record_failure(
    conn: AsyncConnection, row: OutboxRow, error: Exception, *, final: bool
) -> None:
    await conn.execute(
        update(Outbox)
        .where(Outbox.id == row.id)
        .values(
            attempts=Outbox.attempts + 1,
            last_error=f"{type(error).__name__}: {error}",
            failed_at=func.now() if final else None,
        )
    )
    log.warning(
        "outbox.gave_up" if final else "outbox.publish_failed",
        outbox_id=str(row.id),
        kind=row.kind,
        attempts=row.attempts + 1,
        error=str(error),
    )


async def relay_once(
    engine: AsyncEngine,
    client: Client,
    *,
    partition: int,
    partitions: int,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> int:
    """Relay one batch. Returns how many rows it published or recorded a failure for (0 if
    another relay owns the partition). Raises, counting nothing, if Temporal is down."""
    async with engine.begin() as conn:
        if not await own_partition(conn, partition):
            return 0
        rows = await claim(conn, partition=partition, partitions=partitions)
        published: list[uuid.UUID] = []
        failed = 0
        held_keys: set[str] = set()
        for row in rows:
            if row.partition_key in held_keys:
                continue
            try:
                await publish(client, workflow_start(row))
            except Exception as error:
                if is_outage(error):
                    raise
                final = isinstance(error, UnknownKindError) or row.attempts + 1 >= max_attempts
                if not final:
                    held_keys.add(row.partition_key)
                await record_failure(conn, row, error, final=final)
                failed += 1
            else:
                published.append(row.id)
        if published:
            await conn.execute(
                update(Outbox).where(Outbox.id.in_(published)).values(published_at=func.now())
            )
    if published:
        log.info("outbox.published", count=len(published), partition=partition)
    return len(published) + failed


async def run(
    engine: AsyncEngine,
    client: Client,
    stop: asyncio.Event,
    *,
    partition: int,
    partitions: int,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> None:
    while not stop.is_set():
        try:
            progressed = await relay_once(
                engine,
                client,
                partition=partition,
                partitions=partitions,
                max_attempts=max_attempts,
            )
        except Exception as error:
            if is_outage(error):
                log.warning("outbox.temporal_unavailable", partition=partition, error=str(error))
            else:
                log.exception("outbox.relay_failed", partition=partition)
            progressed = 0
        # Go straight on only after a full batch of progress; held-back rows don't count.
        if progressed < BATCH_SIZE:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), POLL_INTERVAL_S)
