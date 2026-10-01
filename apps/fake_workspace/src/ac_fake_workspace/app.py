from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import APIRouter, FastAPI

from ac_core.health import Health
from ac_core.tracing import FASTAPI_TELEMETRY
from ac_fake_workspace import control, routes
from ac_fake_workspace.delivery import DeliveryPolicy, Notifier
from ac_fake_workspace.errors import install_error_handlers
from ac_fake_workspace.faults import Faults
from ac_fake_workspace.routes import Runtime, RuntimeDep
from ac_fake_workspace.settings import WorkspaceSettings, get_workspace_settings
from ac_fake_workspace.state import Clock, CorpusError, Workspace

SERVICE = "fake-workspace"

log = structlog.get_logger(__name__)


class WorkspaceHealth(Health):
    corpus_loaded: bool


health = APIRouter()


@health.get("/health")
async def get_health(rt: RuntimeDep) -> WorkspaceHealth:
    """Always 200, so Compose sees the service up while the corpus is still missing."""
    return WorkspaceHealth(status="ok", service=SERVICE, corpus_loaded=rt.workspace.loaded)


def create_app(
    settings: WorkspaceSettings | None = None, policy: DeliveryPolicy | None = None
) -> FastAPI:
    settings = settings or get_workspace_settings()
    clock = Clock()
    rt = Runtime(
        env=settings.env,
        clock=clock,
        workspace=Workspace(settings.corpus_dir),
        faults=Faults(),
        notifier=Notifier(clock, policy or DeliveryPolicy()),
    )
    try:
        rt.workspace.load()
    except CorpusError as e:
        log.warning("corpus not loaded", error=str(e))

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        yield
        await rt.notifier.close()

    app = FastAPI(title="fake workspace", telemetry=FASTAPI_TELEMETRY, lifespan=lifespan)
    app.state.runtime = rt
    install_error_handlers(app)
    app.include_router(health)
    app.include_router(routes.router)
    app.include_router(control.router)
    return app
