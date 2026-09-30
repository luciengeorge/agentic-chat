from fastapi import FastAPI

from ac_core.health import health_router
from ac_core.tracing import FASTAPI_TELEMETRY

SERVICE = "fake-workspace"


def create_app() -> FastAPI:
    app = FastAPI(title="fake workspace", telemetry=FASTAPI_TELEMETRY)
    app.include_router(health_router(SERVICE))
    return app
