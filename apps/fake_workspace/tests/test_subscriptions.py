import asyncio
import time
import uuid
from typing import Any, Literal

import httpx
import pytest

from ac_fake_workspace.delivery import DeliveryPolicy
from ac_fake_workspace.testing import Corpus, MakeClient, Receiver, serve_receiver

NOW = "2026-10-01T12:00:00Z"
EXPIRES = "2026-10-03T12:00:00Z"
RESOURCE = "sites/kestrel/drive/root"
HARBOUR = {"Authorization": "Bearer dev-workspace-harbour"}
SLOW = DeliveryPolicy(max_attempts=5, base_delay_s=0.3, max_delay_s=0.3, validation_timeout_s=0.5)


def request(receiver: Receiver, **overrides: Any) -> dict[str, Any]:
    body = {
        "changeType": "updated",
        "notificationUrl": receiver.url,
        "resource": RESOURCE,
        "expirationDateTime": EXPIRES,
        "clientState": "kestrel-secret",
    }
    return {**body, **overrides}


async def subscribe(client: httpx.AsyncClient, receiver: Receiver) -> dict[str, Any]:
    await client.post("/_control/clock", json={"now": NOW})
    response = await client.post("/v1.0/subscriptions", json=request(receiver))
    assert response.status_code == 201, response.text
    return response.json()


async def rename(client: httpx.AsyncClient, corpus: Corpus, name: str) -> None:
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    response = await client.post(
        f"/_control/sites/kestrel/items/{memo}/rename", json={"name": name}
    )
    assert response.status_code == 200


async def deliveries(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    flushed = await client.post("/_control/flush")
    assert flushed.status_code == 200
    log = (await client.get("/_control/deliveries")).json()["value"]
    assert flushed.json()["value"] == log
    return log


async def attempted(client: httpx.AsyncClient, count: int = 1) -> list[dict[str, Any]]:
    """The delivery log, once `count` deliveries have made their first attempt."""
    for _ in range(200):
        log: list[dict[str, Any]] = (await client.get("/_control/deliveries")).json()["value"]
        if sum(1 for d in log if d["attempts"]) >= count:
            return log
        await asyncio.sleep(0.01)
    raise AssertionError("no delivery attempt yet")


async def test_handshake_echoes_the_decoded_token(
    client: httpx.AsyncClient, receiver: Receiver
) -> None:
    subscription = await subscribe(client, receiver)
    assert uuid.UUID(subscription.pop("id"))
    assert subscription == {
        "changeType": "updated",
        "notificationUrl": receiver.url,
        "resource": RESOURCE,
        "expirationDateTime": EXPIRES,
        "clientState": "kestrel-secret",
    }
    # Graph's tokens carry spaces and colons, so the endpoint must URL-decode them.
    [token] = receiver.tokens
    assert token.startswith("Validation: ")


@pytest.mark.parametrize("validation", ["wrong", "empty", "slow"])
async def test_failed_handshake_creates_nothing(
    client: httpx.AsyncClient,
    receiver: Receiver,
    corpus: Corpus,
    validation: Literal["wrong", "empty", "slow"],
) -> None:
    receiver.validation = validation
    start = time.monotonic()
    response = await client.post("/v1.0/subscriptions", json=request(receiver))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "InvalidRequest"
    assert "validation" in response.json()["error"]["message"]
    assert time.monotonic() - start < 1.0  # a slow endpoint times out (0.5s in these tests)
    assert len(receiver.tokens) == 1
    await rename(client, corpus, "Heron.pdf")
    assert await deliveries(client) == []


async def test_unreachable_endpoint_fails_the_handshake(
    client: httpx.AsyncClient, receiver: Receiver
) -> None:
    body = request(receiver, notificationUrl="http://127.0.0.1:9/hooks")
    response = await client.post("/v1.0/subscriptions", json=body)
    assert response.status_code == 400


@pytest.mark.parametrize(
    ("overrides", "status"),
    [
        ({"changeType": "created"}, 400),
        ({"resource": "sites/kestrel/drive/items/abc"}, 400),
        ({"resource": "sites/harbour/drive/root"}, 403),
        ({"expirationDateTime": "2026-09-30T12:00:00Z"}, 400),
        ({"expirationDateTime": "2026-11-30T12:00:00Z"}, 400),
        ({"expirationDateTime": "2026-10-03T12:00:00"}, 400),
        ({"notificationUrl": "ftp://example.com/hooks"}, 400),
        ({"clientState": None}, 400),
    ],
)
async def test_bad_subscription_requests(
    client: httpx.AsyncClient, receiver: Receiver, overrides: dict[str, Any], status: int
) -> None:
    await client.post("/_control/clock", json={"now": NOW})
    body = {k: v for k, v in request(receiver, **overrides).items() if v is not None}
    response = await client.post("/v1.0/subscriptions", json=body)
    assert response.status_code == status, response.text
    assert receiver.tokens == []


async def test_leading_slash_on_the_resource_is_accepted(
    client: httpx.AsyncClient, receiver: Receiver
) -> None:
    await client.post("/_control/clock", json={"now": NOW})
    body = request(receiver, resource="/sites/kestrel/drive/root")
    assert (await client.post("/v1.0/subscriptions", json=body)).status_code == 201


async def test_notifications_arrive_in_order_with_retries(
    client: httpx.AsyncClient, receiver: Receiver, corpus: Corpus
) -> None:
    subscription = await subscribe(client, receiver)
    receiver.statuses = [500, 503]
    for name in ("one.pdf", "two.pdf", "three.pdf"):
        await rename(client, corpus, name)
    log = await deliveries(client)
    # The first notification is retried until it lands; the others wait their turn.
    assert [[a["status"] for a in d["attempts"]] for d in log] == [[500, 503, 202], [202], [202]]
    assert [d["state"] for d in log] == ["delivered"] * 3
    assert [d["change_seq"] for d in log] == [1, 2, 3]
    assert {d["subscription_id"] for d in log} == {subscription["id"]}
    assert all(a["at"] == NOW and a["error"] is None for d in log for a in d["attempts"])
    assert len(receiver.notifications) == 5
    notification = dict(receiver.notifications[0]["value"][0])
    tenant = notification.pop("tenantId")
    assert uuid.UUID(tenant)
    assert notification == {
        "subscriptionId": subscription["id"],
        "clientState": "kestrel-secret",
        "changeType": "updated",
        "resource": RESOURCE,
        "subscriptionExpirationDateTime": EXPIRES,
    }
    assert {n["value"][0]["tenantId"] for n in receiver.notifications} == {tenant}


async def test_delivery_gives_up_after_its_attempts(
    client: httpx.AsyncClient, receiver: Receiver, corpus: Corpus
) -> None:
    await subscribe(client, receiver)
    receiver.statuses = [500, 500, 500]
    await rename(client, corpus, "one.pdf")
    await rename(client, corpus, "two.pdf")
    log = await deliveries(client)
    assert [(d["state"], len(d["attempts"])) for d in log] == [("failed", 3), ("delivered", 1)]


async def test_unreachable_endpoint_is_logged(client: httpx.AsyncClient, corpus: Corpus) -> None:
    with serve_receiver() as gone:
        await subscribe(client, gone)
    await rename(client, corpus, "one.pdf")
    [delivery] = await deliveries(client)
    assert delivery["state"] == "failed"
    assert all(a["status"] is None and a["error"] for a in delivery["attempts"])


async def test_only_the_changed_sites_subscriptions_are_notified(
    client: httpx.AsyncClient, receiver: Receiver, corpus: Corpus
) -> None:
    kestrel = [await subscribe(client, receiver) for _ in range(2)]
    body = request(receiver, resource="sites/harbour/drive/root")
    assert (await client.post("/v1.0/subscriptions", json=body, headers=HARBOUR)).is_success
    await rename(client, corpus, "one.pdf")
    log = await deliveries(client)
    assert sorted(d["subscription_id"] for d in log) == sorted(s["id"] for s in kestrel)


async def test_reset_cancels_retries_in_flight(
    make_client: MakeClient, receiver: Receiver, corpus: Corpus
) -> None:
    client = make_client(policy=SLOW)
    await subscribe(client, receiver)
    receiver.statuses = [500] * 5
    await rename(client, corpus, "one.pdf")
    await attempted(client)
    start = time.monotonic()
    assert (await client.post("/_control/reset")).status_code == 200
    assert time.monotonic() - start < 0.3
    assert (await client.get("/_control/deliveries")).json()["value"] == []
    await asyncio.sleep(0.4)
    assert len(receiver.notifications) == 1


async def test_deleting_a_subscription_drops_its_retries(
    make_client: MakeClient, receiver: Receiver, corpus: Corpus
) -> None:
    client = make_client(policy=SLOW)
    subscription = await subscribe(client, receiver)
    receiver.statuses = [500]
    await rename(client, corpus, "one.pdf")
    await attempted(client)
    assert (await client.delete(f"/v1.0/subscriptions/{subscription['id']}")).status_code == 204
    [delivery] = await deliveries(client)
    assert (delivery["state"], len(delivery["attempts"])) == ("dropped", 1)
    assert len(receiver.notifications) == 1


async def test_a_failing_endpoint_doesnt_hold_up_other_subscriptions(
    make_client: MakeClient, receiver: Receiver, corpus: Corpus
) -> None:
    client = make_client(policy=SLOW)
    receiver.statuses = [500] * 5
    failing = await subscribe(client, receiver)
    with serve_receiver() as other:
        healthy = await subscribe(client, other)
        await rename(client, corpus, "one.pdf")
        log = {d["subscription_id"]: d for d in await attempted(client, 2)}
    assert log[healthy["id"]]["state"] == "delivered"
    assert log[failing["id"]]["state"] == "pending"


async def test_renew_and_delete(
    client: httpx.AsyncClient, receiver: Receiver, corpus: Corpus
) -> None:
    subscription = await subscribe(client, receiver)
    url = f"/v1.0/subscriptions/{subscription['id']}"
    renewed = await client.patch(url, json={"expirationDateTime": "2026-10-20T12:00:00Z"})
    assert renewed.status_code == 200
    assert renewed.json()["expirationDateTime"] == "2026-10-20T12:00:00Z"
    await rename(client, corpus, "one.pdf")
    [notified] = await deliveries(client)
    assert notified["state"] == "delivered"
    assert receiver.notifications[0]["value"][0]["subscriptionExpirationDateTime"] == (
        "2026-10-20T12:00:00Z"
    )
    too_far = await client.patch(url, json={"expirationDateTime": "2026-12-20T12:00:00Z"})
    assert too_far.status_code == 400
    assert (await client.delete(url)).status_code == 204
    await rename(client, corpus, "two.pdf")
    assert len(await deliveries(client)) == 1
    assert (await client.delete(url)).status_code == 404
    renew = await client.patch(url, json={"expirationDateTime": EXPIRES})
    assert renew.status_code == 404


async def test_expired_subscriptions_go_quiet(
    client: httpx.AsyncClient, receiver: Receiver, corpus: Corpus
) -> None:
    subscription = await subscribe(client, receiver)
    await client.post("/_control/clock", json={"now": "2026-10-04T00:00:00Z"})
    await rename(client, corpus, "one.pdf")
    assert await deliveries(client) == []
    url = f"/v1.0/subscriptions/{subscription['id']}"
    renew = await client.patch(url, json={"expirationDateTime": "2026-10-05T00:00:00Z"})
    assert renew.status_code == 404


async def test_another_site_cannot_manage_a_subscription(
    client: httpx.AsyncClient, receiver: Receiver
) -> None:
    subscription = await subscribe(client, receiver)
    url = f"/v1.0/subscriptions/{subscription['id']}"
    assert (await client.delete(url, headers=HARBOUR)).status_code == 404
    assert (await client.delete(url)).status_code == 204


async def test_subscriptions_need_a_token(make_client: MakeClient, receiver: Receiver) -> None:
    response = await make_client(token=None).post("/v1.0/subscriptions", json=request(receiver))
    assert response.status_code == 401
