import time

import httpx
import pytest

ITEMS = "/v1.0/sites/kestrel/drive/items"
HARBOUR = {"Authorization": "Bearer dev-workspace-harbour"}


async def add_fault(client: httpx.AsyncClient, **fault: object) -> None:
    response = await client.post("/_control/faults", json=fault)
    assert response.status_code == 201, response.text


async def test_throttle_after_some_requests_for_a_count(client: httpx.AsyncClient) -> None:
    await add_fault(
        client,
        kind="throttle",
        site="kestrel",
        path_prefix=ITEMS,
        after_requests=2,
        count=2,
        retry_after_s=7,
    )
    responses = [await client.get(f"{ITEMS}/root") for _ in range(5)]
    assert [r.status_code for r in responses] == [200, 200, 429, 429, 200]
    throttled = responses[2]
    assert throttled.headers["retry-after"] == "7"
    assert throttled.json()["error"]["code"] == "TooManyRequests"
    # Other paths and other sites are untouched.
    assert (await client.get("/v1.0/sites/kestrel/drive/root")).status_code == 200
    harbour = await client.get("/v1.0/sites/harbour/drive/items/root", headers=HARBOUR)
    assert harbour.status_code == 200


async def test_throttle_lasts_until_cleared(client: httpx.AsyncClient) -> None:
    await add_fault(client, kind="throttle")
    for _ in range(3):
        response = await client.get(f"{ITEMS}/root")
        assert response.status_code == 429
        assert response.headers["retry-after"] == "1"
    assert (await client.delete("/_control/faults")).status_code == 204
    assert (await client.get(f"{ITEMS}/root")).status_code == 200


async def test_rejected_requests_dont_count(client: httpx.AsyncClient) -> None:
    await add_fault(client, kind="throttle", after_requests=1)
    bad = {"Authorization": "Bearer nope"}
    assert (await client.get(f"{ITEMS}/root", headers=bad)).status_code == 401
    assert (await client.get(f"{ITEMS}/root", headers=HARBOUR)).status_code == 403
    assert (await client.get(f"{ITEMS}/root")).status_code == 200
    assert (await client.get(f"{ITEMS}/root")).status_code == 429


async def test_error_fault(client: httpx.AsyncClient) -> None:
    await add_fault(client, kind="error", count=1)
    await add_fault(client, kind="error", status=500, count=1)
    unavailable = await client.get(f"{ITEMS}/root")
    assert unavailable.status_code == 503
    assert unavailable.json()["error"]["code"] == "serviceNotAvailable"
    assert "retry-after" not in unavailable.headers
    failed = await client.get(f"{ITEMS}/root")
    assert failed.status_code == 500
    assert failed.json()["error"]["code"] == "generalException"
    assert (await client.get(f"{ITEMS}/root")).status_code == 200


async def test_error_fault_with_retry_after(client: httpx.AsyncClient) -> None:
    await add_fault(client, kind="error", retry_after_s=3)
    response = await client.get(f"{ITEMS}/root")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "3"


async def test_latency_fault(client: httpx.AsyncClient) -> None:
    await add_fault(client, kind="latency", latency_ms=150, path_prefix=ITEMS)
    start = time.monotonic()
    assert (await client.get(f"{ITEMS}/root")).status_code == 200
    assert time.monotonic() - start >= 0.15


async def test_faults_apply_to_subscriptions(client: httpx.AsyncClient) -> None:
    await add_fault(client, kind="throttle", path_prefix="/v1.0/subscriptions")
    assert (await client.post("/v1.0/subscriptions", json={})).status_code == 429


@pytest.mark.parametrize(
    "fault",
    [
        {"kind": "latency"},
        {"kind": "explode"},
        {"kind": "error", "status": 200},
        {"kind": "throttle", "count": 0},
        {"kind": "throttle", "after_requests": -1},
    ],
)
async def test_invalid_fault_is_400(client: httpx.AsyncClient, fault: dict[str, object]) -> None:
    response = await client.post("/_control/faults", json=fault)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalidRequest"
