import base64
import json
from collections.abc import AsyncIterator

import httpx
import pytest

from ac_api.app import create_app

CLAIMS = {
    "sub": "user-1",
    "tenant": "kestrel",
    "iss": "http://localhost:8081/realms/kestrel",
    "aud": "agentic-api",
}


def encode(claims: object, *, padded: bool = False) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode()
    return raw if padded else raw.rstrip("=")


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as c:
        yield c


async def test_health(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")
    assert response.json() == {"status": "ok", "service": "api"}


@pytest.mark.parametrize("padded", [False, True])
async def test_me_reads_the_forwarded_payload(client: httpx.AsyncClient, padded: bool) -> None:
    response = await client.get(
        "/v1/me",
        headers={"x-jwt-payload": encode(CLAIMS, padded=padded), "x-request-id": "req-1"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "sub": "user-1",
        "tenant": "kestrel",
        "issuer": "http://localhost:8081/realms/kestrel",
        "request_id": "req-1",
    }


async def test_tenant_comes_from_the_issuer(client: httpx.AsyncClient) -> None:
    claims = {**CLAIMS, "tenant": "harbour", "iss": "http://localhost:8081/realms/harbour"}
    response = await client.get("/v1/me", headers={"x-jwt-payload": encode(claims)})
    assert response.json()["tenant"] == "harbour"


async def test_tenant_claim_that_disagrees_with_the_issuer_is_403(
    client: httpx.AsyncClient,
) -> None:
    claims = {**CLAIMS, "tenant": "harbour"}  # issued by the kestrel realm
    response = await client.get("/v1/me", headers={"x-jwt-payload": encode(claims)})
    assert response.status_code == 403


async def test_unknown_issuer_is_401(client: httpx.AsyncClient) -> None:
    claims = {**CLAIMS, "iss": "http://evil.example/realms/kestrel"}
    response = await client.get("/v1/me", headers={"x-jwt-payload": encode(claims)})
    assert response.status_code == 401


async def test_me_without_payload_is_401(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/me")).status_code == 401


@pytest.mark.parametrize(
    "payload",
    [
        "not base64 !!",
        encode("a string, not an object"),
        encode({k: v for k, v in CLAIMS.items() if k != "tenant"}),
        base64.urlsafe_b64encode(b"\xff\xfe").decode(),
    ],
)
async def test_me_with_bad_payload_is_401(client: httpx.AsyncClient, payload: str) -> None:
    response = await client.get("/v1/me", headers={"x-jwt-payload": payload})
    assert response.status_code == 401
