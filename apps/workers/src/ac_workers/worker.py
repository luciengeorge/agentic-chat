from temporalio.client import Client
from temporalio.worker import Worker

from ac_core.temporal import DEFAULT_TASK_QUEUE
from ac_workers.hello.activities import format_greeting
from ac_workers.hello.workflow import HelloWorkflow


def create_worker(client: Client, task_queue: str = DEFAULT_TASK_QUEUE) -> Worker:
    return Worker(
        client,
        task_queue=task_queue,
        workflows=[HelloWorkflow],
        activities=[format_greeting],
    )
