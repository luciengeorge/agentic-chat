import uuid
from collections.abc import AsyncIterator

import pytest
from temporalio.testing import WorkflowEnvironment

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
