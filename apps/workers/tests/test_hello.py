import asyncio
import uuid
from collections.abc import AsyncIterator

import pytest
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from ac_workers.hello.greeting import format_greeting
from ac_workers.hello.workflow import HelloInput, HelloWorkflow
from ac_workers.worker import create_worker


def test_format_greeting() -> None:
    assert format_greeting("smoke") == "hello smoke"


@pytest.fixture
async def env() -> AsyncIterator[WorkflowEnvironment]:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        yield env


async def test_hello_workflow(env: WorkflowEnvironment) -> None:
    task_queue = f"test-{uuid.uuid4()}"
    async with create_worker(env.client, task_queue):
        result = await env.client.execute_workflow(
            HelloWorkflow.run, HelloInput("smoke"), id=str(uuid.uuid4()), task_queue=task_queue
        )
    assert result == "hello smoke"


async def test_hello_workflow_accepts_the_outbox_payload(env: WorkflowEnvironment) -> None:
    task_queue = f"test-{uuid.uuid4()}"
    async with create_worker(env.client, task_queue):
        result = await env.client.execute_workflow(
            "HelloWorkflow", {"name": "relay"}, id=str(uuid.uuid4()), task_queue=task_queue
        )
    assert result == "hello relay"


async def run_with_greeting(env: WorkflowEnvironment, error: Exception) -> int:
    """Runs HelloWorkflow with a format_greeting that always raises `error`. Returns attempts."""
    attempts = 0

    @activity.defn(name="format_greeting")
    async def failing(name: str) -> str:
        nonlocal attempts
        attempts += 1
        raise error

    task_queue = f"test-{uuid.uuid4()}"
    async with Worker(
        env.client, task_queue=task_queue, workflows=[HelloWorkflow], activities=[failing]
    ):
        with pytest.raises(WorkflowFailureError):
            await asyncio.wait_for(
                env.client.execute_workflow(
                    HelloWorkflow.run, HelloInput("x"), id=str(uuid.uuid4()), task_queue=task_queue
                ),
                timeout=30,
            )
    return attempts


async def test_unimplemented_code_is_not_retried(env: WorkflowEnvironment) -> None:
    assert await run_with_greeting(env, NotImplementedError("format_greeting")) == 1


async def test_retries_are_bounded(env: WorkflowEnvironment) -> None:
    assert await run_with_greeting(env, RuntimeError("flaky")) == 5
