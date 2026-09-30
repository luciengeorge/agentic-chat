import asyncio
import contextlib
import signal
from collections.abc import Callable, Generator
from typing import Literal

import uvicorn
from fastapi import APIRouter, FastAPI, Response, status
from pydantic import BaseModel


class Health(BaseModel):
    status: Literal["ok", "loading"]
    service: str


def health_router(service: str, ready: Callable[[], bool] = lambda: True) -> APIRouter:
    """`GET /health`. Answers 503 with status "loading" until `ready()` is true."""
    router = APIRouter()

    @router.get("/health")
    def health(response: Response) -> Health:  # pyright: ignore[reportUnusedFunction]
        if ready():
            return Health(status="ok", service=service)
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return Health(status="loading", service=service)

    return router


def health_app(service: str) -> FastAPI:
    app = FastAPI(title=service, openapi_url=None)
    app.include_router(health_router(service))
    return app


class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None]:
        # The process owns SIGINT/SIGTERM (see shutdown_event), not the health server.
        yield


async def serve_health(service: str, port: int, stop: asyncio.Event) -> None:
    """Health endpoint for processes that aren't HTTP services (workers, relay)."""
    config = uvicorn.Config(health_app(service), host="0.0.0.0", port=port, log_config=None)
    server = _Server(config)
    serving = asyncio.create_task(server.serve())
    await stop.wait()
    server.should_exit = True
    await serving


def shutdown_event() -> asyncio.Event:
    """An event set on SIGINT or SIGTERM. Call it from inside the running loop."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    return stop
