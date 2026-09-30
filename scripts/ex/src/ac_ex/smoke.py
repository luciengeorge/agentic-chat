"""`ex smoke`: the six M0a checks from docs/m0a-contract.md, each run on its own."""

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from html.parser import HTMLParser
from http.cookiejar import Cookie, DefaultCookiePolicy
from pathlib import Path
from typing import cast
from urllib.request import Request

import httpx

from ac_ex import services

# Compose services only: Postgres runs on the host, and the hello check exercises it.
EXPECTED_SERVICES = (
    "redis",
    "minio",
    "opensearch",
    "temporal",
    "keycloak",
    "envoy",
    "ratelimit",
    "grafana",
    "api",
    "workers",
    "relay",
    "reranker",
    "fake-workspace",
)
SMOKE_USER = "smoke.kestrel"
SMOKE_PASSWORD = "smoke-password"
HELLO_TIMEOUT_S = 30.0


class SmokeError(Exception):
    pass


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    detail: str | None
    duration_s: float

    def to_json(self) -> dict[str, object]:
        return {
            "name": self.name,
            "passed": self.passed,
            "detail": self.detail,
            "duration_s": self.duration_s,
        }


Check = Callable[[], Awaitable[str | None]]


async def run_check(name: str, check: Check) -> CheckResult:
    started = time.perf_counter()
    try:
        detail = await check()
        passed = True
    except Exception as exc:  # a smoke check reports every failure, whatever raised it
        detail = str(exc) or type(exc).__name__
        passed = False
    return CheckResult(
        name=name,
        passed=passed,
        detail=detail,
        duration_s=round(time.perf_counter() - started, 3),
    )


async def run_checks(checks: Sequence[tuple[str, Check]]) -> list[CheckResult]:
    return list(await asyncio.gather(*(run_check(name, check) for name, check in checks)))


@dataclass(frozen=True)
class Endpoints:
    web: str = "http://localhost:3000"
    workshop: str = "http://localhost:3100"
    envoy: str = "http://localhost:8080"


# 1. Services


async def check_services(
    statuses: Callable[[], list[services.ServiceStatus]],
    client: httpx.AsyncClient,
    endpoints: Endpoints,
) -> str | None:
    found = {s.name: s for s in await asyncio.to_thread(statuses)}
    problems = [
        f"{name}: {'missing' if name not in found else found[name].health or found[name].state}"
        for name in EXPECTED_SERVICES
        if name not in found or not found[name].healthy
    ]
    for label, url in (("web", endpoints.web), ("workshop", endpoints.workshop)):
        try:
            response = await client.get(url)
            if response.status_code >= 500:
                problems.append(f"{label}: HTTP {response.status_code}")
        except httpx.HTTPError as exc:
            problems.append(f"{label}: {type(exc).__name__} at {url}")
    if problems:
        raise SmokeError("; ".join(problems))
    return None


# 2. Login through the BFF


class LocalhostCookiePolicy(DefaultCookiePolicy):
    """Sends `Secure` cookies to http://localhost, as browsers do (it's a secure context).

    Keycloak marks its login-session cookies `Secure; SameSite=None`, and the stdlib policy
    only sends those over https, so the credentials POST would arrive without them. The flag
    is cleared as the cookie is stored because httpx copies the cookies into a jar with the
    default policy for every request.
    """

    def set_ok(self, cookie: Cookie, request: Request) -> bool:
        if request.host.partition(":")[0] == "localhost":
            cookie.secure = False
        return super().set_ok(cookie, request)


class LoginFormParser(HTMLParser):
    """Finds Keycloak's login form (`#kc-form-login`) and its action URL."""

    def __init__(self) -> None:
        super().__init__()
        self.action: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "form" and values.get("id") == "kc-form-login":
            self.action = values.get("action")


def login_form_action(html: str) -> str | None:
    parser = LoginFormParser()
    parser.feed(html)
    return parser.action


async def check_login(client: httpx.AsyncClient, endpoints: Endpoints) -> str | None:
    page = await client.get(f"{endpoints.web}/auth/login", params={"tenant": "kestrel"})
    action = login_form_action(page.text)
    if not action:
        raise SmokeError(f"no #kc-form-login at {page.url} (HTTP {page.status_code})")
    done = await client.post(
        action, data={"username": SMOKE_USER, "password": SMOKE_PASSWORD, "credentialId": ""}
    )
    if done.status_code >= 400:
        raise SmokeError(f"login ended at {done.url} with HTTP {done.status_code}")
    if not any(cookie.name == "ac_session" for cookie in client.cookies.jar):
        raise SmokeError(f"no ac_session cookie after login (ended at {done.url})")
    me = await client.get(f"{endpoints.web}/api/me")
    if me.status_code != 200:
        raise SmokeError(f"/api/me returned HTTP {me.status_code}")
    tenant = me.json().get("tenant")
    if tenant != "kestrel":
        raise SmokeError(f"/api/me tenant is {tenant!r}, expected 'kestrel'")
    return f"signed in as {SMOKE_USER}"


def http_client(transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    client = httpx.AsyncClient(transport=transport, follow_redirects=True, timeout=10.0)
    client.cookies.jar.set_policy(LocalhostCookiePolicy())
    return client


# 3. Envoy


async def check_envoy(client: httpx.AsyncClient, endpoints: Endpoints) -> str | None:
    health = await client.get(f"{endpoints.envoy}/health")
    if health.status_code != 200:
        raise SmokeError(f"{endpoints.envoy}/health returned HTTP {health.status_code}")
    me = await client.get(f"{endpoints.envoy}/v1/me")
    if me.status_code != 401:
        raise SmokeError(f"/v1/me without a token returned HTTP {me.status_code}, expected 401")
    return None


# 4. Outbox -> relay -> Temporal


@dataclass(frozen=True)
class HelloDeps:
    insert_outbox_row: Callable[[uuid.UUID], Awaitable[str]]
    """Inserts a `hello` row with the given id; returns the tenant slug."""
    await_result: Callable[[str, float], Awaitable[object]]
    """Waits up to the timeout for the workflow id to finish; returns its result."""
    timeout_s: float = HELLO_TIMEOUT_S


async def check_hello(deps: HelloDeps) -> str | None:
    outbox_id = uuid.uuid4()
    tenant = await deps.insert_outbox_row(outbox_id)
    workflow_id = f"{tenant}:hello:{outbox_id}"
    try:
        result = await asyncio.wait_for(
            deps.await_result(workflow_id, deps.timeout_s), timeout=deps.timeout_s
        )
    except TimeoutError:
        raise SmokeError(f"{workflow_id} didn't finish within {deps.timeout_s:.0f}s") from None
    if result != "hello smoke":
        raise SmokeError(f"{workflow_id} returned {result!r}, expected 'hello smoke'")
    return workflow_id


def _database_url() -> str:
    from ac_core.settings import get_settings

    return get_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)


async def insert_hello_row(outbox_id: uuid.UUID) -> str:
    import psycopg
    from psycopg.types.json import Jsonb

    async with await psycopg.AsyncConnection.connect(_database_url()) as conn:
        row = await (
            await conn.execute("SELECT id FROM tenants WHERE slug = %s", ("kestrel",))
        ).fetchone()
        if row is None:
            raise SmokeError("tenant 'kestrel' isn't seeded; run the migrations")
        await conn.execute(
            "INSERT INTO outbox (id, tenant_id, kind, payload, partition_key)"
            " VALUES (%s, %s, 'hello', %s, %s)",
            (outbox_id, row[0], Jsonb({"name": "smoke"}), str(outbox_id)),
        )
    return "kestrel"


async def await_workflow_result(workflow_id: str, timeout_s: float) -> object:
    from temporalio.client import Client
    from temporalio.service import RPCError, RPCStatusCode

    from ac_core.settings import get_settings

    settings = get_settings()
    client = await Client.connect(settings.temporal_address, namespace=settings.temporal_namespace)
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return await client.get_workflow_handle(workflow_id).result()
        except RPCError as exc:
            # The relay hasn't started the workflow yet.
            if exc.status != RPCStatusCode.NOT_FOUND or time.monotonic() > deadline:
                raise
            await asyncio.sleep(0.5)


# 5. Fake model


async def check_fake_model() -> str | None:
    from ac_models import FakeChatModel

    model = FakeChatModel(turns=["pong"])
    response = await model.respond("ping", reasoning="low")
    if response.output_text != "pong":
        raise SmokeError(f"FakeChatModel answered {response.output_text!r}, expected 'pong'")
    if [r.input for r in model.requests] != ["ping"]:
        raise SmokeError("FakeChatModel didn't record the request")
    return None


# 6. Workshop


async def check_workshop(client: httpx.AsyncClient, endpoints: Endpoints) -> str | None:
    response = await client.get(f"{endpoints.workshop}/api/steps")
    if response.status_code != 200:
        raise SmokeError(f"/api/steps returned HTTP {response.status_code}")
    body = cast(dict[str, list[dict[str, object]]], response.json())
    if not any(section.get("id") == "00" for section in body.get("sections", [])):
        raise SmokeError("/api/steps doesn't list section 00")
    return None


@dataclass
class Smoke:
    root: Path
    endpoints: Endpoints = field(default_factory=Endpoints)
    transport: httpx.AsyncBaseTransport | None = None
    statuses: Callable[[], list[services.ServiceStatus]] | None = None
    hello: HelloDeps | None = None
    fake_model: Check = check_fake_model

    def client(self) -> httpx.AsyncClient:
        return http_client(self.transport)

    async def run(self) -> list[CheckResult]:
        async with self.client() as shared, self.client() as login_client:
            statuses = self.statuses or (lambda: services.status(self.root))
            hello = self.hello or HelloDeps(insert_hello_row, await_workflow_result)
            return await run_checks(
                [
                    ("services healthy", lambda: check_services(statuses, shared, self.endpoints)),
                    ("login through the BFF", lambda: check_login(login_client, self.endpoints)),
                    ("envoy /health and 401", lambda: check_envoy(shared, self.endpoints)),
                    ("outbox -> hello workflow", lambda: check_hello(hello)),
                    ("fake model", self.fake_model),
                    ("workshop lists section 00", lambda: check_workshop(shared, self.endpoints)),
                ]
            )
