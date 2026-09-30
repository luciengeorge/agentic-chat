import httpx
from fastapi import FastAPI

from ac_core.health import health_router


async def get_health(app: FastAPI) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://t") as c:
        return await c.get("/health")


async def test_health_ok() -> None:
    app = FastAPI()
    app.include_router(health_router("api"))
    response = await get_health(app)
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "api"}


async def test_health_loading_is_503() -> None:
    app = FastAPI()
    app.include_router(health_router("reranker", ready=lambda: False))
    response = await get_health(app)
    assert response.status_code == 503
    assert response.json() == {"status": "loading", "service": "reranker"}
