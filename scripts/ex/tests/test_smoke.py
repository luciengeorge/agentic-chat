import asyncio
import json
import shutil
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

from ac_core.slots import find_repo_root
from ac_ex import services, smoke
from ac_ex.smoke import Endpoints, HelloDeps, SmokeError
from ac_fake_workspace.app import create_app
from ac_fake_workspace.settings import WorkspaceSettings
from ac_fixtures.corpus import build
from ac_fixtures.world import load_world

REPO = find_repo_root()
WORLD_YAML = REPO / smoke.WORLD
WORLD = load_world(WORLD_YAML)
ADMIN = ("admin", "admin")
E = Endpoints()
KC = "http://localhost:8081"
FORM = (
    '<html><form id="kc-form-login" method="post" '
    f'action="{KC}/realms/kestrel/login-actions/authenticate?session_code=a&amp;execution=b">'
    "</form></html>"
)
MEMO_ID = "11111111-1111-5111-8111-111111111111"
DRIVE = f"{E.workspace}/v1.0/sites/kestrel/drive"
EXEC = str(WORLD.group_id("kestrel", "/Kestrel/Exec"))


def heron_grant(
    group_id: str = EXEC, name: str = "/Kestrel/Exec", roles: tuple[str, ...] = ("write",)
) -> dict[str, object]:
    return {"roles": list(roles), "grantedToV2": {"group": {"id": group_id, "displayName": name}}}


@dataclass
class Drive:
    """Kestrel's site on a fake fake-workspace."""

    children: list[str] = field(default_factory=lambda: ["Company", "Exec", "Finance"])
    permissions: list[dict[str, object]] = field(default_factory=lambda: [heron_grant()])
    harbour_status: int = 403
    loaded: bool = True
    honour_top: bool = True
    child_count: int | None = None  # what the root claims; by default, len(children)
    endless: bool = False  # every page links to the same next page, for 50 pages
    pages_served: int = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        if not self.loaded:
            return httpx.Response(503, json={"error": {"code": "serviceNotReady"}})
        token = request.headers.get("authorization")
        if token == "Bearer dev-workspace-harbour":
            return httpx.Response(self.harbour_status, json={"error": {"code": "accessDenied"}})
        assert token == "Bearer dev-workspace-kestrel"
        params = request.url.params
        match request.url.path.removeprefix("/v1.0/sites/kestrel/drive"):
            case "/root":
                count = len(self.children) if self.child_count is None else self.child_count
                return httpx.Response(200, json={"folder": {"childCount": count}})
            case "/items/root/children" if self.endless and self.pages_served == 50:
                return httpx.Response(500)  # a client that never stops paging fails here
            case "/items/root/children":
                self.pages_served += 1
                top = int(params["$top"]) if self.honour_top else 20
                start = int(params.get("$skiptoken", "0"))
                body: dict[str, object] = {
                    "value": [{"name": n} for n in self.children[start : start + top]]
                }
                if start + top < len(self.children) or self.endless:
                    after = start if self.endless else start + top
                    body["@odata.nextLink"] = (
                        f"{DRIVE}/items/root/children?$top={top}&$skiptoken={after}"
                    )
                return httpx.Response(200, json=body)
            case path if path == f"/items/{MEMO_ID}/permissions":
                return httpx.Response(200, json={"value": self.permissions})
            case _:
                return httpx.Response(404)


@dataclass
class Directory:
    """Kestrel's realm on a fake Keycloak: who may sign in, and what the admin API returns."""

    accounts: dict[str, str] = field(
        default_factory=lambda: {
            "smoke.kestrel": "smoke-password",
            "leo.martin": "dev-password",
            "peter.hall": "dev-password",
        }
    )
    ids: dict[str, str] = field(
        default_factory=lambda: {
            "leo.martin": str(WORLD.user_id("kestrel", "leo.martin")),
            "peter.hall": str(WORLD.user_id("kestrel", "peter.hall")),
            "/Kestrel/Finance/AP": str(WORLD.group_id("kestrel", "/Kestrel/Finance/AP")),
        }
    )
    enabled: dict[str, bool] = field(default_factory=lambda: {"peter.hall": False})

    def sign_in(self, username: str, password: str) -> httpx.Response:
        """Keycloak re-renders its form with an error, as it does for a bad password or a
        disabled account."""
        if self.accounts.get(username) != password:
            error = "Invalid username or password."
        elif not self.enabled.get(username, True):
            error = "Account is disabled, contact your administrator."
        else:
            location = f"{E.web}/auth/callback?code={username}"
            return httpx.Response(302, headers={"location": location})
        error_html = f'<span id="input-error">{error}</span>'
        return httpx.Response(200, text=FORM.replace("</form>", f"</form>{error_html}"))

    def admin(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/realms/master/protocol/openid-connect/token":
            form = dict(httpx.QueryParams(request.content.decode()))
            if (form.get("username"), form.get("password")) != ADMIN:
                return httpx.Response(401)
            assert form["client_id"] == "admin-cli"
            return httpx.Response(200, json={"access_token": "adm"})
        if request.headers.get("authorization") != "Bearer adm":
            return httpx.Response(401)
        path = request.url.path.removeprefix("/admin/realms/kestrel")
        if path == "/users":
            assert request.url.params["exact"] == "true"
            name = request.url.params["username"]
            if name not in self.ids:
                return httpx.Response(200, json=[])
            enabled = self.enabled.get(name, True)
            return httpx.Response(200, json=[{"id": self.ids[name], "enabled": enabled}])
        group = path.removeprefix("/group-by-path")
        if group in self.ids:
            return httpx.Response(200, json={"id": self.ids[group], "path": group})
        return httpx.Response(404)


def write_manifest(path: Path, memo_traps: tuple[str, ...] = ("acl-leak",)) -> Path:
    items = [
        {"id": "r", "path": "/", "kind": "folder"},
        {"id": MEMO_ID, "path": "/Exec/Heron.pdf", "name": "Heron.pdf", "traps": list(memo_traps)},
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "sites": {"kestrel": {"items": items}}}))
    return path


def stack(
    *,
    tenant: str = "kestrel",
    form: str = FORM,
    set_cookie: bool = True,
    envoy_me: int = 401,
    sections: tuple[str, ...] = ("00",),
    drive: Drive | None = None,
    directory: Directory | None = None,
) -> httpx.MockTransport:
    """A fake BFF, Keycloak, Envoy, workshop app and fake-workspace."""
    workspace = drive or Drive()
    realm = directory or Directory()

    def handler(request: httpx.Request) -> httpx.Response:
        url = request.url
        match (request.method, f"{url.scheme}://{url.host}:{url.port}", url.path):
            case ("GET", E.web, "/auth/login"):
                assert url.params["tenant"] == "kestrel"
                return httpx.Response(302, headers={"location": f"{KC}/realms/kestrel/auth"})
            case ("GET", _, "/realms/kestrel/auth"):
                # Keycloak's own login-session cookie, which it needs back on the POST.
                cookie = "AUTH_SESSION_ID=k1; Path=/realms/kestrel/; Secure; SameSite=None"
                return httpx.Response(200, text=form, headers={"set-cookie": cookie})
            case ("POST", _, "/realms/kestrel/login-actions/authenticate"):
                if "AUTH_SESSION_ID=k1" not in request.headers.get("cookie", ""):
                    return httpx.Response(400, text="Cookie not found")
                assert url.params["execution"] == "b"
                body = dict(httpx.QueryParams(request.content.decode()))
                return realm.sign_in(body["username"], body["password"])
            case ("GET", E.web, "/auth/callback"):
                headers = {"location": f"{E.web}/"}
                if set_cookie:
                    session = f"ac_session={url.params['code']}; Path=/; HttpOnly; SameSite=Lax"
                    headers["set-cookie"] = session
                return httpx.Response(302, headers=headers)
            case ("GET", E.web, "/api/me"):
                if "ac_session=" not in request.headers.get("cookie", ""):
                    return httpx.Response(401)
                return httpx.Response(200, json={"sub": "u1", "tenant": tenant})
            case (_, E.keycloak, _):
                return realm.admin(request)
            case ("GET", E.web | E.workshop, "/"):
                return httpx.Response(200, text="ok")
            case ("GET", E.envoy, "/health"):
                return httpx.Response(200, json={"status": "ok", "service": "api"})
            case ("GET", E.envoy, "/v1/me"):
                return httpx.Response(envoy_me)
            case ("GET", E.workshop, "/api/steps"):
                return httpx.Response(200, json={"sections": [{"id": s} for s in sections]})
            case ("GET", E.workspace, _):
                return workspace.handle(request)
            case _:
                return httpx.Response(404)

    return httpx.MockTransport(handler)


def client(transport: httpx.AsyncBaseTransport) -> httpx.AsyncClient:
    return smoke.http_client(transport)


def healthy() -> list[services.ServiceStatus]:
    return [services.ServiceStatus(n, "running", "healthy") for n in smoke.EXPECTED_SERVICES]


async def test_login() -> None:
    async with client(stack()) as c:
        assert await smoke.check_login(c, E) == "signed in as smoke.kestrel"


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"tenant": "harbour"}, "tenant is 'harbour'"),
        ({"form": "<html>Sign in</html>"}, "no #kc-form-login"),
        ({"set_cookie": False}, "no ac_session cookie"),
    ],
)
async def test_login_failures(kwargs: dict[str, object], error: str) -> None:
    async with client(stack(**kwargs)) as c:  # pyright: ignore[reportArgumentType]
        with pytest.raises(SmokeError, match=error):
            await smoke.check_login(c, E)


def test_login_form_action_unescapes() -> None:
    action = smoke.login_form_action(FORM)
    assert action is not None
    assert action.endswith("session_code=a&execution=b")


async def test_envoy() -> None:
    async with client(stack()) as c:
        assert await smoke.check_envoy(c, E) is None
    async with client(stack(envoy_me=200)) as c:
        with pytest.raises(SmokeError, match="expected 401"):
            await smoke.check_envoy(c, E)


async def test_workshop() -> None:
    async with client(stack()) as c:
        assert await smoke.check_workshop(c, E) is None
    async with client(stack(sections=("01",))) as c:
        with pytest.raises(SmokeError, match="doesn't list section 00"):
            await smoke.check_workshop(c, E)


async def test_services() -> None:
    async with client(stack()) as c:
        assert await smoke.check_services(healthy, c, E) is None


async def test_services_reports_every_problem() -> None:
    def statuses() -> list[services.ServiceStatus]:
        rest = [s for s in healthy() if s.name not in ("relay", "keycloak")]
        return [*rest, services.ServiceStatus("keycloak", "running", "starting")]

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async with client(httpx.MockTransport(refuse)) as c:
        with pytest.raises(SmokeError) as info:
            await smoke.check_services(statuses, c, E)
    assert str(info.value) == (
        "keycloak: starting; relay: missing; web: ConnectError at http://localhost:3000; "
        "workshop: ConnectError at http://localhost:3100"
    )


def hello(result: object, delay: float = 0.0) -> HelloDeps:
    inserted: list[uuid.UUID] = []

    async def insert(outbox_id: uuid.UUID) -> str:
        inserted.append(outbox_id)
        return "kestrel"

    async def await_result(workflow_id: str, timeout_s: float) -> object:
        assert workflow_id == f"kestrel:hello:{inserted[0]}"
        await asyncio.sleep(delay)
        return result

    return HelloDeps(insert, await_result, timeout_s=0.2)


async def test_hello() -> None:
    detail = await smoke.check_hello(hello("hello smoke"))
    assert detail is not None
    assert detail.startswith("kestrel:hello:")


async def test_hello_wrong_result() -> None:
    with pytest.raises(SmokeError, match="returned 'hi'"):
        await smoke.check_hello(hello("hi"))


async def test_hello_timeout() -> None:
    with pytest.raises(SmokeError, match="didn't finish within"):
        await smoke.check_hello(hello("hello smoke", delay=1.0))


async def test_fake_model() -> None:
    assert await smoke.check_fake_model() is None


async def test_run_check_captures_any_exception() -> None:
    async def boom() -> str | None:
        raise RuntimeError("kaput")

    result = await smoke.run_check("boom", boom)
    assert (result.name, result.passed, result.detail) == ("boom", False, "kaput")


async def test_workspace(tmp_path: Path) -> None:
    manifest = write_manifest(tmp_path / "manifest.json")
    async with client(stack()) as c:
        detail = await smoke.check_workspace(c, E, manifest, WORLD_YAML)
    assert detail == "3 root children over 2 pages; Heron.pdf: /Kestrel/Exec (write) only"


@pytest.mark.parametrize(
    ("drive", "error"),
    [
        (Drive(loaded=False), "no corpus loaded; run `ex fixtures`"),
        (Drive(honour_top=False), r"a \$top=2 page of the root has 3 children"),
        (Drive(child_count=4), r"paging the root gave .*, expected 4 distinct children"),
        (
            Drive(children=["Company", "Exec", "Exec"]),
            r"paging the root gave \['Company', 'Exec', 'Exec'\], expected 3 distinct",
        ),
        (
            Drive(
                permissions=[
                    heron_grant(),
                    {"roles": ["read"], "grantedToV2": {"user": {"id": "u1", "displayName": "T"}}},
                ]
            ),
            r"shared with .*'u1', 'T'.*, expected only",
        ),
        (Drive(permissions=[]), r"shared with \[\], expected only"),
        # The right name on another group's id: only the id says who really holds the grant.
        (Drive(permissions=[heron_grant(group_id="g1")]), "'g1', '/Kestrel/Exec'.*expected"),
        (Drive(permissions=[heron_grant(roles=("read",))]), r"\['read'\].*expected"),
        (Drive(harbour_status=200), "Harbour's token on Kestrel's site got HTTP 200, not 403"),
    ],
    ids=[
        "no corpus",
        "top ignored",
        "short of the child count",
        "a child twice",
        "extra grantee",
        "no grantee",
        "wrong group id",
        "wrong role",
        "harbour allowed",
    ],
)
async def test_workspace_failures(tmp_path: Path, drive: Drive, error: str) -> None:
    manifest = write_manifest(tmp_path / "manifest.json")
    async with client(stack(drive=drive)) as c:
        with pytest.raises(SmokeError, match=error):
            await smoke.check_workspace(c, E, manifest, WORLD_YAML)


async def test_workspace_stops_paging_a_nextlink_that_never_ends(tmp_path: Path) -> None:
    manifest = write_manifest(tmp_path / "manifest.json")
    async with client(stack(drive=Drive(endless=True))) as c:
        with pytest.raises(SmokeError, match=r"still had a nextLink after 3 pages"):
            await smoke.check_workspace(c, E, manifest, WORLD_YAML)


async def test_workspace_needs_the_manifest_and_its_memo(tmp_path: Path) -> None:
    async with client(stack()) as c:
        with pytest.raises(SmokeError, match=r"manifest\.json is missing; run `ex fixtures`"):
            await smoke.check_workspace(c, E, tmp_path / "manifest.json", WORLD_YAML)
        manifest = write_manifest(tmp_path / "manifest.json", memo_traps=())
        with pytest.raises(SmokeError, match="0 acl-leak documents, expected 1"):
            await smoke.check_workspace(c, E, manifest, WORLD_YAML)


# The check against the real fake-workspace, serving a corpus from the real build.

HERON = "exec-project-heron-board-memo"
SOURCES = (HERON, "hr-leave-policy", "company-office-guide")


@pytest.fixture(scope="module")
def corpus(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A real build of the world with three real sources, among them the Project Heron memo."""
    root = tmp_path_factory.mktemp("corpus")
    sources = root / "sources" / "kestrel"
    sources.mkdir(parents=True)
    for doc in SOURCES:
        shutil.copy(REPO / "fixtures" / "corpus" / "sources" / "kestrel" / f"{doc}.md", sources)
    build.build(root / "build", world_path=WORLD_YAML, sources_root=root / "sources")
    return root / "build"


@pytest.fixture
async def workspace(corpus: Path) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(WorkspaceSettings(corpus_dir=corpus, env="dev"))
    yield smoke.http_client(httpx.ASGITransport(app))
    await app.state.runtime.notifier.close()


FW = Endpoints(workspace="http://fw")


async def test_workspace_against_the_real_fake_workspace(
    workspace: httpx.AsyncClient, corpus: Path
) -> None:
    async with workspace as c:
        detail = await smoke.check_workspace(c, FW, corpus / "manifest.json", WORLD_YAML)
    top_level = sorted({f.path.split("/")[1] for f in WORLD.tenants["kestrel"].folders})
    pages = -(-len(top_level) // 2)
    assert detail == (
        f"{len(top_level)} root children over {pages} pages; "
        "Project Heron Board Memo.pdf: /Kestrel/Exec (write) only"
    )


async def test_an_older_corpus_on_fake_workspace_says_to_run_ex_fixtures(
    workspace: httpx.AsyncClient, corpus: Path, tmp_path: Path
) -> None:
    """The host's manifest is newer than the corpus fake-workspace loaded: the memo moved."""
    manifest: dict[str, Any] = json.loads((corpus / "manifest.json").read_text())
    [memo] = [i for i in manifest["sites"]["kestrel"]["items"] if i.get("doc_id") == HERON]
    memo["id"] = str(WORLD.item_id("kestrel", "/Exec/Board/Project Heron Board Memo.pdf"))
    newer = tmp_path / "manifest.json"
    newer.write_text(json.dumps(manifest))
    async with workspace as c:
        with pytest.raises(SmokeError, match="serves an older corpus; run `ex fixtures`"):
            await smoke.check_workspace(c, FW, newer, WORLD_YAML)


# 8. Directory


def clients(transport: httpx.AsyncBaseTransport) -> Any:
    return lambda: client(transport)


async def test_directory() -> None:
    detail = await smoke.check_directory(clients(stack()), E, WORLD_YAML, ADMIN)
    assert detail == (
        "leo.martin signed in, peter.hall (disabled) was refused; "
        "leo.martin, peter.hall and /Kestrel/Finance/AP carry the world's ids"
    )


@pytest.mark.parametrize(
    ("directory", "admin", "error"),
    [
        (Directory(accounts={"peter.hall": "dev-password"}), ADMIN, "no ac_session cookie"),
        (Directory(enabled={}), ADMIN, "peter.hall is disabled but signed in"),
        # Refused, but for a bad password: the account might not be disabled at all.
        (
            Directory(accounts={"leo.martin": "dev-password", "peter.hall": "other"}),
            ADMIN,
            "peter.hall was refused, but not as a disabled account",
        ),
        (Directory(), ("admin", "nope"), "admin login returned HTTP 401"),
        (
            Directory(ids={"peter.hall": str(WORLD.user_id("kestrel", "peter.hall"))}),
            ADMIN,
            "Keycloak has 0 users named leo.martin",
        ),
        (
            Directory(
                ids={
                    "leo.martin": "u1",
                    "peter.hall": str(WORLD.user_id("kestrel", "peter.hall")),
                    "/Kestrel/Finance/AP": "g1",
                }
            ),
            ADMIN,
            r"leo.martin has id u1, the world says .*; /Kestrel/Finance/AP has id g1",
        ),
        (
            Directory(
                ids={
                    "leo.martin": str(WORLD.user_id("kestrel", "leo.martin")),
                    "peter.hall": "u2",
                    "/Kestrel/Finance/AP": str(WORLD.group_id("kestrel", "/Kestrel/Finance/AP")),
                }
            ),
            ADMIN,
            r"^peter.hall has id u2, the world says ",
        ),
    ],
    ids=[
        "user refused",
        "disabled user let in",
        "refused as a bad password",
        "bad admin",
        "no user",
        "wrong ids",
        "wrong disabled user id",
    ],
)
async def test_directory_failures(directory: Directory, admin: tuple[str, str], error: str) -> None:
    with pytest.raises(SmokeError, match=error):
        await smoke.check_directory(clients(stack(directory=directory)), E, WORLD_YAML, admin)


def test_keycloak_admin_comes_from_compose(tmp_path: Path) -> None:
    assert smoke.keycloak_admin(REPO / services.COMPOSE_FILE) == ADMIN
    compose = tmp_path / "compose.yaml"
    compose.write_text(
        "services:\n  keycloak:\n    environment:\n"
        "      KC_BOOTSTRAP_ADMIN_USERNAME: root\n      KC_BOOTSTRAP_ADMIN_PASSWORD: s3cret\n"
    )
    assert smoke.keycloak_admin(compose) == ("root", "s3cret")


def fake_repo(root: Path) -> Path:
    """What `Smoke` reads from the repo: the manifest, the world and Compose's Keycloak admin."""
    write_manifest(root / smoke.MANIFEST)
    (root / smoke.WORLD).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(WORLD_YAML, root / smoke.WORLD)
    compose = root / services.COMPOSE_FILE
    compose.parent.mkdir(parents=True)
    compose.write_text(
        "services:\n  keycloak:\n    environment:\n"
        "      KC_BOOTSTRAP_ADMIN_USERNAME: admin\n      KC_BOOTSTRAP_ADMIN_PASSWORD: admin\n"
    )
    return root


async def test_all_checks_pass_against_a_fake_stack(tmp_path: Path) -> None:
    results = await smoke.Smoke(
        root=fake_repo(tmp_path), transport=stack(), statuses=healthy, hello=hello("hello smoke")
    ).run()
    assert [r.name for r in results] == [
        "services healthy",
        "login through the BFF",
        "envoy /health and 401",
        "outbox -> hello workflow",
        "fake model",
        "workshop lists section 00",
        "fake-workspace pages and shares",
        "directory logins and ids",
    ]
    assert all(r.passed for r in results), results


async def test_checks_fail_independently(tmp_path: Path) -> None:
    results = await smoke.Smoke(
        root=fake_repo(tmp_path),
        transport=stack(envoy_me=200),
        statuses=healthy,
        hello=hello("hello smoke"),
    ).run()
    assert [r.passed for r in results] == [True, True, False, True, True, True, True, True]
