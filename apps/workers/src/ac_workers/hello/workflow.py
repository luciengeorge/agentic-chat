from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from ac_workers.hello.activities import format_greeting


@dataclass(frozen=True)
class HelloInput:
    name: str


@workflow.defn
class HelloWorkflow:
    @workflow.run
    async def run(self, input: HelloInput) -> str:
        return await workflow.execute_activity(
            format_greeting, input.name, start_to_close_timeout=timedelta(seconds=10)
        )
