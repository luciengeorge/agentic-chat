"""`ex fixtures`: regenerate the realm exports, build the corpus, and reset fake-workspace.

The renderers are imported inside the functions: they're heavy, and every other `ex` command
would pay for them at start-up.
"""

import tempfile
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from ac_ex.errors import ExError

if TYPE_CHECKING:
    from ac_fixtures.corpus.build import BuildReport

WORKSPACE_URL = "http://localhost:8100"
KEYCLOAK_RECREATE = (
    "Keycloak is running and imports realms only when it's created; "
    "recreate it to load the new exports"
)


@dataclass(frozen=True)
class Endpoints:
    workspace: str = WORKSPACE_URL
    keycloak: str | None = None  # default: AC_KEYCLOAK_URL


ENDPOINTS = Endpoints()


def run(root: Path, *, clean: bool) -> tuple[dict[str, object], str, bool]:
    started = time.perf_counter()
    changed, report = _build(
        root, root / "fixtures" / "directory", root / "fixtures" / "corpus" / "build", clean=clean
    )
    recreate = changed and _reachable(_keycloak_url(ENDPOINTS))
    keycloak = KEYCLOAK_RECREATE if recreate else None
    reset, detail, ok = _reset_workspace(ENDPOINTS.workspace)
    files = [str(path.relative_to(root)) for path in changed]
    payload: dict[str, object] = {
        "directory": {"changed": files, "detail": keycloak},
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
    return payload, "\n".join(lines), ok


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


def _keycloak_url(endpoints: Endpoints) -> str:
    if endpoints.keycloak is not None:
        return endpoints.keycloak
    from ac_core.settings import get_settings

    return get_settings().keycloak_url


def _reachable(url: str) -> bool:
    """Something listens at `url`, even if it's too busy to answer in time."""
    try:
        httpx.get(url, timeout=2.0)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return False
    except httpx.TransportError:
        return True
    return True
