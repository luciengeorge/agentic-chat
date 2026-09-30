from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from ac_workers.hello.activities import format_greeting

# Bounded, with backoff. A NotImplementedError is a step not done yet: retrying can't fix it.
RETRY_POLICY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=5,
    non_retryable_error_types=["NotImplementedError"],
)


@dataclass(frozen=True)
class HelloInput:
    name: str


@workflow.defn
class HelloWorkflow:
    @workflow.run
    async def run(self, input: HelloInput) -> str:
        return await workflow.execute_activity(
            format_greeting,
            input.name,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RETRY_POLICY,
        )
