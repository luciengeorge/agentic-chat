import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from ac_fake_workspace.testing import Corpus, MakeClient, ManualClock, Receiver

ITEMS = "/v1.0/sites/kestrel/drive/items"
HARBOUR = {"Authorization": "Bearer dev-workspace-harbour"}


async def eventually(condition: Callable[[], object]) -> None:
    for _ in range(1000):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


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


async def test_latency_fault(make_client: MakeClient) -> None:
    clock = ManualClock()
    client = make_client(clock=clock)
    await add_fault(client, kind="latency", latency_ms=150, path_prefix=ITEMS)
    await add_fault(client, kind="latency", latency_ms=50, path_prefix=ITEMS, count=1)
    assert (await client.get(f"{ITEMS}/root")).status_code == 200
    assert (await client.get(f"{ITEMS}/root")).status_code == 200
    assert (await client.get("/v1.0/sites/kestrel/drive/root")).status_code == 200
    # Latencies stack, a count runs out, and other paths wait for nothing.
    assert clock.waits == [0.15, 0.05, 0.15]


async def test_a_reset_that_fails_during_a_latency_wait_is_503(
    make_client: MakeClient, corpus: Corpus
) -> None:
    """The request passed its corpus check before the wait; the corpus is gone after it."""
    clock = ManualClock()
    clock.gate = asyncio.Event()
    client = make_client(clock=clock)
    await add_fault(client, kind="latency", latency_ms=100, path_prefix=ITEMS)
    waiting = asyncio.create_task(client.get(f"{ITEMS}/root"))
    await eventually(lambda: clock.waits)
    (corpus.dir / "manifest.json").write_text("{}")
    assert (await client.post("/_control/reset")).status_code == 503
    clock.gate.set()
    response = await waiting
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "serviceNotReady"


async def test_a_subscribe_held_across_a_failed_reset_is_503(
    make_client: MakeClient, corpus: Corpus, receiver: Receiver
) -> None:
    clock = ManualClock()
    clock.gate = asyncio.Event()
    client = make_client(clock=clock)
    await add_fault(client, kind="latency", latency_ms=100, path_prefix="/v1.0/subscriptions")
    body = {
        "changeType": "updated",
        "notificationUrl": receiver.url,
        "resource": "sites/kestrel/drive/root",
        "expirationDateTime": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        "clientState": "s",
    }
    waiting = asyncio.create_task(client.post("/v1.0/subscriptions", json=body))
    await eventually(lambda: clock.waits)
    (corpus.dir / "manifest.json").write_text("{}")
    assert (await client.post("/_control/reset")).status_code == 503
    clock.gate.set()
    response = await waiting
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "serviceNotReady"


async def test_a_request_held_across_a_reset_answers_as_a_fresh_one(
    make_client: MakeClient, corpus: Corpus
) -> None:
    """The reset loads a corpus without Kestrel's site, so Kestrel's token opens nothing."""
    clock = ManualClock()
    clock.gate = asyncio.Event()
    client = make_client(clock=clock)
    await add_fault(client, kind="latency", latency_ms=100, path_prefix=ITEMS, count=1)
    waiting = asyncio.create_task(client.get(f"{ITEMS}/root"))
    await eventually(lambda: clock.waits)
    manifest = corpus.dir / "manifest.json"
    data = json.loads(manifest.read_text())
    del data["sites"]["kestrel"]
    manifest.write_text(json.dumps(data))
    assert (await client.post("/_control/reset")).status_code == 200
    clock.gate.set()
    held, fresh = await waiting, await client.get(f"{ITEMS}/root")
    assert (held.status_code, held.json()) == (fresh.status_code, fresh.json())
    assert fresh.json()["error"]["code"] == "InvalidAuthenticationToken"


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
