"""`ex fixtures`: regenerate the realm exports, build the corpus, and reset fake-workspace.

The renderers are imported inside the functions: they're heavy, and every other `ex` command
would pay for them at start-up.
"""

import hashlib
import json
import tempfile
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from ac_ex import services
from ac_ex.errors import ExError

if TYPE_CHECKING:
    from ac_fixtures.corpus.build import BuildReport

WORKSPACE_URL = "http://localhost:8100"
# Which realm exports which Keycloak container loaded, so a reload that failed is retried.
REALMS_APPLIED = Path(".ex/realm-applied.json")
REALM_EXPORTS = "*-realm.json"


@dataclass(frozen=True)
class Endpoints:
    workspace: str = WORKSPACE_URL


ENDPOINTS = Endpoints()


@dataclass(frozen=True)
class Stack:
    """The Compose calls that load new realm exports; the tests swap in fakes."""

    status: Callable[[Path], list[services.ServiceStatus]] = services.status
    recreate: Callable[[Path, str], None] = services.recreate_service
    remove: Callable[[Path, str], None] = services.remove_service


STACK = Stack()


def run(root: Path, *, clean: bool) -> tuple[dict[str, object], str, bool]:
    started = time.perf_counter()
    changed, report = _build(
        root, root / "fixtures" / "directory", root / "fixtures" / "corpus" / "build", clean=clean
    )
    recreated, keycloak, realms_ok = _load_realms(root, STACK)
    reset, detail, reset_ok = _reset_workspace(ENDPOINTS.workspace)
    files = [str(path.relative_to(root)) for path in changed]
    payload: dict[str, object] = {
        "directory": {"changed": files, "recreated": recreated, "detail": keycloak},
        "corpus": report.to_json(),
        "workspace": {"reset": reset, "detail": detail},
        "duration_s": round(time.perf_counter() - started, 3),
    }
    lines = [
        f"directory: {', '.join(files) if files else 'realm exports unchanged'}",
        *([f"  {keycloak}"] if keycloak else []),
        f"corpus: {report.documents} documents, {report.rendered} rendered, "
        f"{report.reused} reused, {report.bytes / 1e6:.1f} MB, "
        f"manifest {report.manifest_sha256[:12]}",
        f"workspace: {detail}",
    ]
    return payload, "\n".join(lines), realms_ok and reset_ok


def verify(root: Path) -> tuple[dict[str, object], str, bool]:
    """Builds the realm exports and the corpus twice, from scratch, and compares every byte."""
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="ac-fixtures-verify-") as tmp:
        builds = [Path(tmp) / "first", Path(tmp) / "second"]
        reports = [_build(root, out / "directory", out / "corpus")[1] for out in builds]
        differences = _differences(*builds)
        files = sum(1 for path in builds[0].rglob("*") if path.is_file())
    identical = not differences
    payload: dict[str, object] = {
        "verify": {"identical": identical, "files": files, "differences": differences},
        "corpus": reports[0].to_json(),
        "duration_s": round(time.perf_counter() - started, 3),
    }
    verdict = (
        f"two builds are byte-identical ({files} files)"
        if identical
        else "the two builds differ:\n" + "\n".join(f"  {d}" for d in differences)
    )
    return payload, verdict, identical


def _build(
    root: Path, directory: Path, corpus: Path, *, clean: bool = False
) -> "tuple[list[Path], BuildReport]":
    """The realm exports into `directory` and the corpus into `corpus`, from `root`'s inputs."""
    from ac_fixtures import directory as realms
    from ac_fixtures.corpus import build
    from ac_fixtures.world import load_world

    world = root / "fixtures" / "world.yaml"
    with _problems():
        if clean:
            build.clean(corpus)
        report = build.build(
            corpus, world_path=world, sources_root=root / "fixtures" / "corpus" / "sources"
        )
        # Only after the corpus built, so a failed run doesn't swallow the realm change that
        # the next run would have to report.
        changed = realms.write_realm_exports(load_world(world), directory)
    return changed, report


@contextmanager
def _problems() -> Generator[None]:
    """Turns the fixtures' own errors into an ExError listing every problem."""
    from ac_fixtures.corpus.build import CorpusError
    from ac_fixtures.sources import SourceError
    from ac_fixtures.world import WorldError

    try:
        yield
    except WorldError as exc:
        raise ExError("world.yaml has problems", detail=list(exc.problems)) from exc
    except SourceError as exc:
        raise ExError("the corpus sources have problems", detail=list(exc.problems)) from exc
    except CorpusError as exc:
        raise ExError("some documents failed to render", detail=list(exc.problems)) from exc
    except OSError as exc:
        raise ExError("can't read or write the fixtures", detail=str(exc)) from exc


def _differences(first: Path, second: Path) -> list[str]:
    def files(root: Path) -> dict[str, Path]:
        return {str(p.relative_to(root)): p for p in root.rglob("*") if p.is_file()}

    a, b = files(first), files(second)
    out: list[str] = []
    for name in sorted(a.keys() | b.keys()):
        if name not in b:
            out.append(f"{name}: only in the first build")
        elif name not in a:
            out.append(f"{name}: only in the second build")
        elif a[name].read_bytes() != b[name].read_bytes():
            out.append(f"{name}: bytes differ")
    return out


def exports_digest(directory: Path) -> str:
    """One sha256 over the realm exports: what Keycloak imports when its container is created."""
    digest = hashlib.sha256()
    for path in sorted(directory.glob(REALM_EXPORTS)):
        digest.update(f"{path.name}\0{path.stat().st_size}\0".encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


@dataclass(frozen=True)
class Applied:
    """What `.ex/realm-applied.json` says Keycloak and Envoy last loaded."""

    digest: str | None = None
    keycloak: str | None = None
    """The container that imported `digest`. None: no container did, so whichever Keycloak runs
    next is reloaded, since nothing says which exports it was created from."""
    envoy_pending: bool = False
    """Keycloak was recreated, but Envoy may still hold the old container's keys."""


def _applied(root: Path) -> Applied:
    try:
        data = json.loads((root / REALMS_APPLIED).read_text(encoding="utf-8"))
        return Applied(data["digest"], data.get("keycloak"), bool(data.get("envoy_pending")))
    except (OSError, ValueError, KeyError, TypeError):
        return Applied()


def _mark_applied(root: Path, applied: Applied) -> None:
    path = root / REALMS_APPLIED
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "digest": applied.digest,
        "keycloak": applied.keycloak,
        "envoy_pending": applied.envoy_pending,
    }
    path.write_text(json.dumps(body) + "\n", encoding="utf-8")


def _load_realms(root: Path, stack: Stack) -> tuple[list[str], str | None, bool]:
    """(recreated services, detail, ok): make Keycloak serve the realm exports on disk.

    Keycloak imports realms only when its container is created, so a running one is recreated and
    a stopped one removed (`ex up` would start it again on the old realms). A new container signs
    with new keys, and Envoy would answer 401 until its JWKS cache expired, so a running Envoy is
    recreated after it: it fetches the keys before it opens its listener.

    The record names the exports and the Keycloak container that loaded them. The exports are
    written before this runs, so a failed reload leaves them unchanged for the next run, and a
    Keycloak made elsewhere (another branch's `ex up`) can hold other exports under the same
    digest. Either way the container no longer matches, and the reload happens. A Keycloak that
    reloaded before Envoy failed isn't recreated again: only Envoy is.
    """
    digest = exports_digest(root / "fixtures" / "directory")
    applied = _applied(root)
    try:
        found = {s.name: s for s in stack.status(root)}
    except services.DockerMissingError:
        if applied.digest == digest:
            return [], None, True
        return [], "docker isn't on PATH, so the realm reload waits for the next run", True
    except ExError as exc:
        return (
            [],
            f"couldn't read the stack's status, so the realms weren't checked{_why(exc)}",
            False,
        )
    keycloak = found.get("keycloak")
    if keycloak is None:  # no stack: `ex up` creates Keycloak with these exports
        _mark_applied(root, Applied(digest))
        return [], None, True
    envoy = found.get("envoy")
    recreated: list[str] = []
    try:
        if keycloak.state != "running":
            stack.remove(root, "keycloak")
            _mark_applied(root, Applied(digest))
            return [], "removed the stopped Keycloak, so `ex up` imports the new exports", True
        if (applied.digest, applied.keycloak) != (digest, keycloak.id):
            stack.recreate(root, "keycloak")
            recreated.append("keycloak")
            new = next((s.id for s in stack.status(root) if s.name == "keycloak"), None)
            applied = Applied(digest, new, envoy_pending=True)
            _mark_applied(root, applied)
        if applied.envoy_pending:
            # A stopped Envoy fetches the new keys when it starts.
            if envoy is not None and envoy.state == "running":
                stack.recreate(root, "envoy")
                recreated.append("envoy")
            _mark_applied(root, replace(applied, envoy_pending=False))
    except ExError as exc:
        return recreated, f"couldn't reload the realms{_why(exc)}", False
    if not recreated:
        return [], None, True
    if recreated == ["envoy"]:
        return recreated, "recreated envoy, which still had the old Keycloak's keys", True
    return recreated, f"recreated {' and '.join(recreated)} to load the realm exports", True


def _why(exc: ExError) -> str:
    output = f": {str(exc.detail).strip()[-300:]}" if exc.detail else ""
    return f": {exc.message}{output}"


def _reset_workspace(url: str) -> tuple[bool, str, bool]:
    """(reset, detail, ok). Not running is fine; running and refusing the reset is not."""
    try:
        response = httpx.post(f"{url}/_control/reset", timeout=30.0)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return False, f"fake-workspace isn't running at {url}; nothing to reset", True
    except httpx.TransportError as exc:
        return False, f"fake-workspace didn't finish the reset: {type(exc).__name__} {exc}", False
    if response.is_success:
        return True, "fake-workspace reloaded the corpus", True
    return (
        False,
        f"fake-workspace refused the reset: HTTP {response.status_code} {response.text[:200]}",
        False,
    )
