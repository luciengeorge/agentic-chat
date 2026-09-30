"""Relay entry point: `python -m ac_relay`."""

from ac_core import slots

slots.install()

import asyncio

from ac_core.health import serve_health, shutdown_event
from ac_core.logging import configure_logging
from ac_core.settings import get_settings
from ac_core.temporal import connect
from ac_core.tracing import configure_tracing
from ac_db.engine import create_direct_engine
from ac_relay.relay import run

SERVICE = "relay"
HEALTH_PORT = 8301


async def main() -> None:
    settings = get_settings()
    configure_logging(SERVICE)
    configure_tracing(SERVICE, settings)
    stop = shutdown_event()
    engine = create_direct_engine(settings.database_url)
    client = await connect(settings)
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(serve_health(SERVICE, HEALTH_PORT, stop))
            tg.create_task(
                run(
                    engine,
                    client,
                    stop,
                    partition=settings.relay_partition,
                    partitions=settings.relay_partitions,
                )
            )
    finally:
        await engine.dispose()
