from fastapi import FastAPI

from ac_core.health import health_router

SERVICE = "fake-workspace"


def create_app() -> FastAPI:
    app = FastAPI(title="fake workspace")
    app.include_router(health_router(SERVICE))
    return app
