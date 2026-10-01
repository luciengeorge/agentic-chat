"""`ex smoke`: the six M0a checks from docs/m0a-contract.md and M0b's seventh and eighth
(docs/m0b-contract.md), each run on its own."""

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from html.parser import HTMLParser
from http.cookiejar import Cookie, DefaultCookiePolicy
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import quote
from urllib.request import Request

import httpx
import yaml

from ac_ex import services

if TYPE_CHECKING:
    from ac_fixtures.world import World

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
MANIFEST = Path("fixtures/corpus/build/manifest.json")
WORLD = Path("fixtures/world.yaml")
HERON_GROUP = "/Kestrel/Exec"
HERON_ROLES = ["write"]  # /Exec's grant in world.yaml; the memo adds none of its own
DIRECTORY_USER = "leo.martin"
DISABLED_USER = "peter.hall"
DISABLED_MESSAGE = "Account is disabled"  # Keycloak's error for a disabled user's sign-in
NESTED_GROUP = "/Kestrel/Finance/AP"


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
    workspace: str = "http://localhost:8100"
    keycloak: str = "http://localhost:8081"


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


async def sign_in(
    client: httpx.AsyncClient, endpoints: Endpoints, username: str, password: str
) -> httpx.Response:
    """Starts the BFF's login for Kestrel and posts the credentials to Keycloak's form. Returns
    where that ended: back at the BFF with a session cookie, unless Keycloak refused."""
    page = await client.get(f"{endpoints.web}/auth/login", params={"tenant": "kestrel"})
    action = login_form_action(page.text)
    if not action:
        raise SmokeError(f"no #kc-form-login at {page.url} (HTTP {page.status_code})")
    return await client.post(
        action, data={"username": username, "password": password, "credentialId": ""}
    )


def has_session(client: httpx.AsyncClient) -> bool:
    return any(cookie.name == "ac_session" for cookie in client.cookies.jar)


async def check_login(
    client: httpx.AsyncClient,
    endpoints: Endpoints,
    username: str = SMOKE_USER,
    password: str = SMOKE_PASSWORD,
) -> str | None:
    done = await sign_in(client, endpoints, username, password)
    if done.status_code >= 400:
        raise SmokeError(f"login ended at {done.url} with HTTP {done.status_code}")
    if not has_session(client):
        raise SmokeError(f"no ac_session cookie after login (ended at {done.url})")
    me = await client.get(f"{endpoints.web}/api/me")
    if me.status_code != 200:
        raise SmokeError(f"/api/me returned HTTP {me.status_code}")
    tenant = me.json().get("tenant")
    if tenant != "kestrel":
        raise SmokeError(f"/api/me tenant is {tenant!r}, expected 'kestrel'")
    return f"signed in as {username}"


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


# 7. fake-workspace


def _bearer(site: str) -> dict[str, str]:
    return {"authorization": f"Bearer dev-workspace-{site}"}


async def _graph(
    client: httpx.AsyncClient,
    url: str,
    site: str,
    params: dict[str, int] | None = None,
    *,
    missing: str | None = None,
) -> Any:
    """GET a Graph URL as `site`'s connector. A 404 raises `missing`, when given."""
    response = await client.get(url, headers=_bearer(site), params=params)
    if response.status_code == 503:
        raise SmokeError("fake-workspace has no corpus loaded; run `ex fixtures`")
    if response.status_code == 404 and missing is not None:
        raise SmokeError(missing)
    if response.status_code != 200:
        raise SmokeError(f"GET {response.url} returned HTTP {response.status_code}")
    return response.json()


def read_manifest(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SmokeError(f"{path} is missing; run `ex fixtures`") from None


def read_world(path: Path) -> "World":
    from ac_fixtures.world import load_world

    return load_world(path)


def acl_leak_memo(manifest: dict[str, Any]) -> dict[str, Any]:
    """The Kestrel file whose traps include `acl-leak`: the Project Heron memo."""
    found = [
        i for i in manifest["sites"]["kestrel"]["items"] if "acl-leak" in (i.get("traps") or [])
    ]
    if len(found) != 1:
        raise SmokeError(f"the manifest has {len(found)} acl-leak documents, expected 1")
    return found[0]


def _grant(permission: dict[str, Any]) -> tuple[list[str], str, str, str]:
    """(roles, principal kind, principal id, display name) of a Graph permission."""
    [(kind, principal)] = permission["grantedToV2"].items()
    return permission["roles"], kind, principal["id"], principal["displayName"]


async def check_workspace(
    client: httpx.AsyncClient, endpoints: Endpoints, manifest_path: Path, world_path: Path
) -> str | None:
    drive = f"{endpoints.workspace}/v1.0/sites/kestrel/drive"
    root = await _graph(client, f"{drive}/root", "kestrel")
    expected = root["folder"]["childCount"]
    limit = -(-expected // 2) + 1  # the pages $top=2 needs, and one to spare
    names: list[str] = []
    pages = 0
    url: str | None = f"{drive}/items/root/children"
    params: dict[str, int] | None = {"$top": 2}
    while url is not None:
        if pages == limit:
            raise SmokeError(f"the root's children still had a nextLink after {limit} pages")
        page = await _graph(client, url, "kestrel", params)
        params = None  # the nextLink carries the query
        if len(page["value"]) > 2:
            raise SmokeError(f"a $top=2 page of the root has {len(page['value'])} children")
        names.extend(child["name"] for child in page["value"])
        pages += 1
        url = page.get("@odata.nextLink")
    if len(names) != expected or len(set(names)) != len(names):
        raise SmokeError(f"paging the root gave {names}, expected {expected} distinct children")

    memo = acl_leak_memo(await asyncio.to_thread(read_manifest, manifest_path))
    world = await asyncio.to_thread(read_world, world_path)
    stale = (
        f"fake-workspace has no {memo['name']} ({memo['id']}), which {manifest_path} lists: "
        "it serves an older corpus; run `ex fixtures`"
    )
    permissions = await _graph(
        client, f"{drive}/items/{memo['id']}/permissions", "kestrel", missing=stale
    )
    grants = [_grant(p) for p in permissions["value"]]
    expected = [(HERON_ROLES, "group", str(world.group_id("kestrel", HERON_GROUP)), HERON_GROUP)]
    if grants != expected:
        raise SmokeError(f"{memo['name']} is shared with {grants}, expected only {expected}")

    other = await client.get(f"{drive}/root", headers=_bearer("harbour"))
    if other.status_code != 403:
        raise SmokeError(f"Harbour's token on Kestrel's site got HTTP {other.status_code}, not 403")
    return (
        f"{len(names)} root children over {pages} pages; "
        f"{memo['name']}: {HERON_GROUP} ({', '.join(HERON_ROLES)}) only"
    )


# 8. Directory


def keycloak_admin(compose_file: Path) -> tuple[str, str]:
    """The dev admin's username and password, as Compose bootstraps Keycloak with them."""
    compose = cast(dict[str, Any], yaml.safe_load(compose_file.read_text(encoding="utf-8")))
    env = cast(dict[str, str], compose["services"]["keycloak"]["environment"])
    return env["KC_BOOTSTRAP_ADMIN_USERNAME"], env["KC_BOOTSTRAP_ADMIN_PASSWORD"]


async def _admin_get(
    client: httpx.AsyncClient, url: str, token: str, params: dict[str, str] | None = None
) -> Any:
    response = await client.get(url, headers={"authorization": f"Bearer {token}"}, params=params)
    if response.status_code != 200:
        raise SmokeError(f"GET {response.url} returned HTTP {response.status_code}")
    return response.json()


async def check_directory(
    client: Callable[[], httpx.AsyncClient],
    endpoints: Endpoints,
    world_path: Path,
    admin: tuple[str, str],
) -> str | None:
    """A seeded user signs in and a disabled one can't, and Keycloak holds the world's ids."""
    world = await asyncio.to_thread(read_world, world_path)
    password = world.tenants["kestrel"].password
    async with client() as user:
        await check_login(user, endpoints, DIRECTORY_USER, password)
    async with client() as former:
        done = await sign_in(former, endpoints, DISABLED_USER, password)
        if has_session(former):
            raise SmokeError(f"{DISABLED_USER} is disabled but signed in (ended at {done.url})")
        if DISABLED_MESSAGE not in done.text:
            raise SmokeError(
                f"{DISABLED_USER} was refused, but not as a disabled account (ended at {done.url})"
            )

    async with client() as kc:
        username, secret = admin
        token = await kc.post(
            f"{endpoints.keycloak}/realms/master/protocol/openid-connect/token",
            data={
                "grant_type": "password",
                "client_id": "admin-cli",
                "username": username,
                "password": secret,
            },
        )
        if token.status_code != 200:
            raise SmokeError(f"Keycloak's admin login returned HTTP {token.status_code}")
        access = token.json()["access_token"]
        realm = f"{endpoints.keycloak}/admin/realms/kestrel"
        found: dict[str, Any] = {}
        for name in (DIRECTORY_USER, DISABLED_USER):
            query = {"exact": "true", "username": name}
            users = await _admin_get(kc, f"{realm}/users", access, query)
            if len(users) != 1:
                raise SmokeError(f"Keycloak has {len(users)} users named {name}, expected 1")
            found[name] = users[0]
        group = await _admin_get(kc, f"{realm}/group-by-path{quote(NESTED_GROUP)}", access)

    problems = [
        f"{label} has id {actual}, the world says {wanted}"
        for label, actual, wanted in (
            (DIRECTORY_USER, found[DIRECTORY_USER]["id"], world.user_id("kestrel", DIRECTORY_USER)),
            (DISABLED_USER, found[DISABLED_USER]["id"], world.user_id("kestrel", DISABLED_USER)),
            (NESTED_GROUP, group["id"], world.group_id("kestrel", NESTED_GROUP)),
        )
        if actual != str(wanted)
    ]
    if problems:
        raise SmokeError("; ".join(problems))
    return (
        f"{DIRECTORY_USER} signed in, {DISABLED_USER} (disabled) was refused; "
        f"{DIRECTORY_USER}, {DISABLED_USER} and {NESTED_GROUP} carry the world's ids"
    )


@dataclass
class Smoke:
    root: Path
    endpoints: Endpoints = field(default_factory=Endpoints)
    transport: httpx.AsyncBaseTransport | None = None
    statuses: Callable[[], list[services.ServiceStatus]] | None = None
    hello: HelloDeps | None = None
    fake_model: Check = check_fake_model
    manifest: Path | None = None  # default: <root>/fixtures/corpus/build/manifest.json
    world: Path | None = None  # default: <root>/fixtures/world.yaml

    def client(self) -> httpx.AsyncClient:
        return http_client(self.transport)

    async def run(self) -> list[CheckResult]:
        async with self.client() as shared, self.client() as login_client:
            statuses = self.statuses or (lambda: services.status(self.root))
            hello = self.hello or HelloDeps(insert_hello_row, await_workflow_result)
            manifest = self.manifest or self.root / MANIFEST
            world = self.world or self.root / WORLD

            async def directory() -> str | None:
                admin = await asyncio.to_thread(keycloak_admin, self.root / services.COMPOSE_FILE)
                return await check_directory(self.client, self.endpoints, world, admin)

            return await run_checks(
                [
                    ("services healthy", lambda: check_services(statuses, shared, self.endpoints)),
                    ("login through the BFF", lambda: check_login(login_client, self.endpoints)),
                    ("envoy /health and 401", lambda: check_envoy(shared, self.endpoints)),
                    ("outbox -> hello workflow", lambda: check_hello(hello)),
                    ("fake model", self.fake_model),
                    ("workshop lists section 00", lambda: check_workshop(shared, self.endpoints)),
                    (
                        "fake-workspace pages and shares",
                        lambda: check_workspace(shared, self.endpoints, manifest, world),
                    ),
                    ("directory logins and ids", directory),
                ]
            )
