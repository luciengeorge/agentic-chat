import asyncio
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest

from ac_ex import services, smoke
from ac_ex.smoke import Endpoints, HelloDeps, SmokeError

E = Endpoints()
KC = "http://localhost:8081"
FORM = (
    '<html><form id="kc-form-login" method="post" '
    f'action="{KC}/realms/kestrel/login-actions/authenticate?session_code=a&amp;execution=b">'
    "</form></html>"
)
MEMO_ID = "11111111-1111-5111-8111-111111111111"
DRIVE = f"{E.workspace}/v1.0/sites/kestrel/drive"


@dataclass
class Drive:
    """Kestrel's site on a fake fake-workspace."""

    children: list[str] = field(default_factory=lambda: ["Company", "Exec", "Finance"])
    grantees: list[dict[str, object]] = field(
        default_factory=lambda: [{"group": {"id": "g1", "displayName": "/Kestrel/Exec"}}]
    )
    harbour_status: int = 403
    loaded: bool = True
    honour_top: bool = True

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
                return httpx.Response(200, json={"folder": {"childCount": len(self.children)}})
            case "/items/root/children":
                top = int(params["$top"]) if self.honour_top else 20
                start = int(params.get("$skiptoken", "0"))
                body: dict[str, object] = {
                    "value": [{"name": n} for n in self.children[start : start + top]]
                }
                if start + top < len(self.children):
                    body["@odata.nextLink"] = (
                        f"{DRIVE}/items/root/children?$top={top}&$skiptoken={start + top}"
                    )
                return httpx.Response(200, json=body)
            case path if path == f"/items/{MEMO_ID}/permissions":
                grants = [{"roles": ["write"], "grantedToV2": g} for g in self.grantees]
                return httpx.Response(200, json={"value": grants})
            case _:
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
) -> httpx.MockTransport:
    """A fake BFF, Keycloak, Envoy, workshop app and fake-workspace."""
    workspace = drive or Drive()

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
                body = request.content.decode()
                assert "username=smoke.kestrel" in body
                assert "password=smoke-password" in body
                return httpx.Response(302, headers={"location": f"{E.web}/auth/callback?code=c"})
            case ("GET", E.web, "/auth/callback"):
                headers = {"location": f"{E.web}/"}
                if set_cookie:
                    headers["set-cookie"] = "ac_session=s1; Path=/; HttpOnly; SameSite=Lax"
                return httpx.Response(302, headers=headers)
            case ("GET", E.web, "/api/me"):
                if "ac_session=s1" not in request.headers.get("cookie", ""):
                    return httpx.Response(401)
                return httpx.Response(200, json={"sub": "u1", "tenant": tenant})
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
        detail = await smoke.check_workspace(c, E, manifest)
    assert detail == "3 root children over 2 pages; Heron.pdf: /Kestrel/Exec only"


@pytest.mark.parametrize(
    ("drive", "error"),
    [
        (Drive(loaded=False), "no corpus loaded; run `ex fixtures`"),
        (Drive(honour_top=False), r"a \$top=2 page of the root has 3 children"),
        (
            Drive(
                grantees=[
                    {"group": {"id": "g1", "displayName": "/Kestrel/Exec"}},
                    {"user": {"id": "u1", "displayName": "Tom Whitfield"}},
                ]
            ),
            "shared with .*Tom Whitfield.*, expected only /Kestrel/Exec",
        ),
        (Drive(grantees=[]), r"shared with \[\], expected only /Kestrel/Exec"),
        (Drive(harbour_status=200), "Harbour's token on Kestrel's site got HTTP 200, not 403"),
    ],
    ids=["no corpus", "top ignored", "extra grantee", "no grantee", "harbour allowed"],
)
async def test_workspace_failures(tmp_path: Path, drive: Drive, error: str) -> None:
    manifest = write_manifest(tmp_path / "manifest.json")
    async with client(stack(drive=drive)) as c:
        with pytest.raises(SmokeError, match=error):
            await smoke.check_workspace(c, E, manifest)


async def test_workspace_needs_the_manifest_and_its_memo(tmp_path: Path) -> None:
    async with client(stack()) as c:
        with pytest.raises(SmokeError, match=r"manifest\.json is missing; run `ex fixtures`"):
            await smoke.check_workspace(c, E, tmp_path / "manifest.json")
        manifest = write_manifest(tmp_path / "manifest.json", memo_traps=())
        with pytest.raises(SmokeError, match="0 acl-leak documents, expected 1"):
            await smoke.check_workspace(c, E, manifest)


async def test_all_checks_pass_against_a_fake_stack(tmp_path: Path) -> None:
    write_manifest(tmp_path / smoke.MANIFEST)
    results = await smoke.Smoke(
        root=tmp_path, transport=stack(), statuses=healthy, hello=hello("hello smoke")
    ).run()
    assert [r.name for r in results] == [
        "services healthy",
        "login through the BFF",
        "envoy /health and 401",
        "outbox -> hello workflow",
        "fake model",
        "workshop lists section 00",
        "fake-workspace pages and shares",
    ]
    assert all(r.passed for r in results), results


async def test_checks_fail_independently(tmp_path: Path) -> None:
    results = await smoke.Smoke(
        root=tmp_path,
        transport=stack(envoy_me=200),
        statuses=healthy,
        hello=hello("hello smoke"),
        manifest=write_manifest(tmp_path / "manifest.json"),
    ).run()
    assert [r.passed for r in results] == [True, True, False, True, True, True, True]
