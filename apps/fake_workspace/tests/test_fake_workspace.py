import httpx

from ac_fake_workspace.app import create_app


async def test_health() -> None:
    transport = httpx.ASGITransport(create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://fw") as client:
        response = await client.get("/health")
    assert response.json() == {"status": "ok", "service": "fake-workspace"}
