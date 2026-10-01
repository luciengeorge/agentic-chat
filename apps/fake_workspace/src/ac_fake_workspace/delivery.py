"""Graph-style subscriptions: the validation handshake, then change notifications delivered in
order per subscription, retried with backoff, and logged."""

import asyncio
import functools
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

import httpx
import structlog
from pydantic import AwareDatetime, BaseModel, Field

from ac_fake_workspace.errors import GraphError, bad_request, not_found
from ac_fake_workspace.state import NAMESPACE, Clock, iso

log = structlog.get_logger(__name__)

MAX_LIFETIME = timedelta(minutes=42300)  # Graph's limit for driveItem subscriptions


@dataclass(frozen=True)
class DeliveryPolicy:
    max_attempts: int = 8
    base_delay_s: float = 1.0
    max_delay_s: float = 60.0
    timeout_s: float = 3.0  # Graph waits 3s for the first attempt, then 10s for retries
    retry_timeout_s: float = 10.0
    validation_timeout_s: float = 10.0


class SubscriptionRequest(BaseModel):
    change_type: str = Field(alias="changeType")
    notification_url: str = Field(alias="notificationUrl")
    resource: str
    expiration: AwareDatetime = Field(alias="expirationDateTime")
    client_state: str = Field(alias="clientState", max_length=128)


class SubscriptionRenewal(BaseModel):
    expiration: AwareDatetime = Field(alias="expirationDateTime")


@dataclass
class Subscription:
    id: str
    site: str
    resource: str
    notification_url: str
    client_state: str
    expiration: datetime

    def graph(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "changeType": "updated",
            "notificationUrl": self.notification_url,
            "resource": self.resource,
            "expirationDateTime": iso(self.expiration),
            "clientState": self.client_state,
        }


@dataclass
class Attempt:
    at: datetime
    status: int | None
    error: str | None


@dataclass
class Delivery:
    id: int
    subscription_id: str
    change_seq: int
    state: Literal["pending", "delivered", "failed", "dropped"] = "pending"
    attempts: list[Attempt] = field(default_factory=list[Attempt])

    def graph(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "subscription_id": self.subscription_id,
            "change_seq": self.change_seq,
            "state": self.state,
            "attempts": [
                {"at": iso(a.at), "status": a.status, "error": a.error} for a in self.attempts
            ],
        }


def tenant_id(site: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{site}:tenant"))


class Notifier:
    def __init__(self, clock: Clock, policy: DeliveryPolicy) -> None:
        self.clock = clock
        self.policy = policy
        self.subscriptions: dict[str, Subscription] = {}
        self.deliveries: list[Delivery] = []
        self._requests = 0
        self._tails: dict[str, asyncio.Task[None]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._client: httpx.AsyncClient | None = None

    async def subscribe(self, site: str, request: SubscriptionRequest) -> Subscription:
        if request.change_type != "updated":
            raise bad_request("A drive supports only the 'updated' change type.")
        resource = request.resource.removeprefix("/")
        if resource != f"sites/{site}/drive/root":
            if resource.endswith("/drive/root") and resource.startswith("sites/"):
                raise GraphError(403, "accessDenied", "The token can't open that site.")
            raise bad_request("Subscriptions are only supported on sites/{site}/drive/root.")
        url = httpx.URL(request.notification_url)
        if url.scheme not in ("http", "https") or not url.host:
            raise bad_request("The notificationUrl must be an http or https URL.")
        self._check_expiration(request.expiration)
        self._requests += 1
        request_id = uuid.uuid5(NAMESPACE, f"{site}:validation:{self._requests}")
        await self._validate(
            request.notification_url,
            f"Validation: Testing client application reachability for subscription "
            f"Request-Id: {request_id}",
        )
        subscription = Subscription(
            id=str(uuid.uuid5(NAMESPACE, f"{site}:subscription:{self._requests}")),
            site=site,
            resource=request.resource,
            notification_url=request.notification_url,
            client_state=request.client_state,
            expiration=request.expiration,
        )
        self.subscriptions[subscription.id] = subscription
        return subscription

    def renew(self, site: str, subscription_id: str, expiration: datetime) -> Subscription:
        subscription = self._live(site, subscription_id)
        self._check_expiration(expiration)
        subscription.expiration = expiration
        return subscription

    def remove(self, site: str, subscription_id: str) -> None:
        del self.subscriptions[self._live(site, subscription_id).id]

    def changed(self, site: str, seq: int) -> None:
        """A change landed in `site`: queue a notification for each of its live subscriptions."""
        for subscription in self.subscriptions.values():
            if subscription.site == site and self._active(subscription):
                delivery = Delivery(len(self.deliveries) + 1, subscription.id, seq)
                self.deliveries.append(delivery)
                previous = self._tails.get(subscription.id)
                task = asyncio.create_task(self._deliver(subscription, delivery, previous))
                self._tails[subscription.id] = task
                self._tasks.add(task)
                task.add_done_callback(functools.partial(self._forget, subscription.id))

    async def flush(self) -> None:
        while self._tasks:
            await asyncio.wait(set(self._tasks))

    async def reset(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self.subscriptions.clear()
        self.deliveries.clear()
        self._tails.clear()
        self._requests = 0

    async def close(self) -> None:
        await self.reset()
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _forget(self, subscription_id: str, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if self._tails.get(subscription_id) is task:
            del self._tails[subscription_id]

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(trust_env=False)
        return self._client

    def _check_expiration(self, expiration: datetime) -> None:
        now = self.clock.now()
        if expiration <= now:
            raise bad_request("Subscription expiration must be in the future.")
        if expiration > now + MAX_LIFETIME:
            raise bad_request("Subscription expiration can only be 42300 minutes in the future.")

    def _active(self, subscription: Subscription) -> bool:
        current = self.subscriptions.get(subscription.id) is subscription
        return current and self.clock.now() < subscription.expiration

    def _live(self, site: str, subscription_id: str) -> Subscription:
        subscription = self.subscriptions.get(subscription_id)
        if subscription is None or subscription.site != site or not self._active(subscription):
            raise not_found("No such subscription.")
        return subscription

    async def _validate(self, url: str, token: str) -> None:
        failed = "Subscription validation request failed."
        try:
            response = await self._http().post(
                url,
                params={"validationToken": token},
                headers={"Content-Type": "text/plain; charset=utf-8"},
                timeout=self.policy.validation_timeout_s,
            )
        except httpx.TimeoutException as e:
            raise GraphError(
                400, "InvalidRequest", "Subscription validation request timed out."
            ) from e
        except httpx.HTTPError as e:
            raise GraphError(400, "InvalidRequest", f"{failed} {e}") from e
        if response.status_code != 200:
            message = (
                f"{failed} Notification endpoint must respond with 200 OK to validation request."
            )
            raise GraphError(400, "InvalidRequest", message)
        if not response.headers.get("content-type", "").startswith("text/plain"):
            raise GraphError(400, "InvalidRequest", f"{failed} The response must be text/plain.")
        if response.text != token:
            message = f"{failed} Response must exactly match validationToken query parameter."
            raise GraphError(400, "InvalidRequest", message)

    async def _deliver(
        self, subscription: Subscription, delivery: Delivery, previous: asyncio.Task[None] | None
    ) -> None:
        if previous is not None:
            await asyncio.wait({previous})
        policy = self.policy
        for attempt in range(1, policy.max_attempts + 1):
            if not self._active(subscription):
                delivery.state = "dropped"
                return
            status, error = await self._post(subscription, attempt)
            delivery.attempts.append(Attempt(self.clock.now(), status, error))
            log.info(
                "notification delivery",
                subscription_id=subscription.id,
                delivery_id=delivery.id,
                attempt=attempt,
                status=status,
                error=error,
            )
            if status is not None and 200 <= status < 300:
                delivery.state = "delivered"
                return
            if attempt < policy.max_attempts:
                await asyncio.sleep(
                    min(policy.base_delay_s * 2 ** (attempt - 1), policy.max_delay_s)
                )
        delivery.state = "failed"

    async def _post(
        self, subscription: Subscription, attempt: int
    ) -> tuple[int | None, str | None]:
        notification = {
            "subscriptionId": subscription.id,
            "clientState": subscription.client_state,
            "changeType": "updated",
            "resource": subscription.resource,
            "subscriptionExpirationDateTime": iso(subscription.expiration),
            "tenantId": tenant_id(subscription.site),
        }
        timeout = self.policy.timeout_s if attempt == 1 else self.policy.retry_timeout_s
        try:
            response = await self._http().post(
                subscription.notification_url, json={"value": [notification]}, timeout=timeout
            )
        except Exception as e:  # any failure is a failed attempt, retried like a non-2xx answer
            return None, f"{type(e).__name__}: {e}"
        return response.status_code, None
