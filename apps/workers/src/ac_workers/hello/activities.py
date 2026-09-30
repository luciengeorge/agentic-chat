from temporalio import activity

from ac_workers.hello import greeting


@activity.defn(name="format_greeting")
async def format_greeting(name: str) -> str:
    return greeting.format_greeting(name)
