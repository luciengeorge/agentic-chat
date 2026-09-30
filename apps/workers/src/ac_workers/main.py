"""Worker entry point: `python -m ac_workers`."""

from ac_core import slots

slots.install()

import asyncio

from ac_core.health import serve_health, shutdown_event
from ac_core.logging import configure_logging
from ac_core.settings import get_settings
from ac_core.temporal import connect
from ac_core.tracing import configure_tracing
from ac_workers.worker import create_worker

SERVICE = "workers"
HEALTH_PORT = 8300


async def main() -> None:
    settings = get_settings()
    configure_logging(SERVICE)
    configure_tracing(SERVICE, settings)
    stop = shutdown_event()
    worker = create_worker(await connect(settings))
    async with asyncio.TaskGroup() as tg:
        tg.create_task(serve_health(SERVICE, HEALTH_PORT, stop))
        tg.create_task(worker.run())
        await stop.wait()
        await worker.shutdown()
