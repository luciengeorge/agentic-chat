import json
import shutil
import socket
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from ac_core.slots import find_repo_root
from ac_ex import cli, fixtures, services
from ac_ex.errors import ExError

runner = CliRunner()

REPORT = """---
id: exec-report
title: Exec Report
folder: /Exec
filename: Exec Report.pdf
format: pdf
author: amara.okafor
created: 2026-03-03
modified: 2026-03-04
---
# Exec report

Meals are capped at £40 a day.

| Item | Amount |
|---|--:|
| Meals | £40 |
"""

POLICY = """---
id: hr-leave-policy
title: Leave Policy
folder: /HR/Policies
filename: Leave Policy.md
format: md
author: marco.bianchi
created: 2026-01-05
modified: 2026-01-05
---
# Leave policy

Everyone gets 27 days.
"""


class Server:
    """A localhost HTTP server answering every request with `status`, or hanging up without an
    answer, and recording what it got."""

    def __init__(self) -> None:
        self.status = 200
        self.hang_up = False
        self.requests: list[tuple[str, str]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                server.requests.append((self.command, self.path))
                if server.hang_up:
                    self.close_connection = True
                    return
                self.send_response(server.status)
                self.send_header("content-length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = do_POST = _answer  # noqa: N815 (http.server's names)

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.http.shutdown()
        self.http.server_close()


def closed_url() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{sock.getsockname()[1]}"


class FakeStack:
    """The Compose stack, recording each recreate and remove."""

    def __init__(self) -> None:
        self.states = {"keycloak": "running", "envoy": "running", "api": "running"}
        self.calls: list[str] = []
        self.fail: str | None = None
        self.status_error: ExError | None = None

    def stack(self) -> fixtures.Stack:
        def status(root: Path) -> list[services.ServiceStatus]:
            if self.status_error is not None:
                raise self.status_error
            return [services.ServiceStatus(n, s, "healthy") for n, s in self.states.items()]

        def act(verb: str) -> Callable[[Path, str], None]:
            def call(root: Path, name: str) -> None:
                self.calls.append(f"{verb} {name}")
                if self.fail == name:
                    raise ExError(f"docker compose up {name} failed", detail="unhealthy\n")

            return call

        return fixtures.Stack(status=status, recreate=act("recreate"), remove=act("remove"))


@pytest.fixture
def server() -> Iterator[Server]:
    running = Server()
    yield running
    running.close()


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> FakeStack:
    fake = FakeStack()
    monkeypatch.setattr(fixtures, "STACK", fake.stack())
    return fake


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, server: Server, stack: FakeStack) -> Path:
    """A repo with the real world, two sources, and fake-workspace, Keycloak and Envoy up."""
    root = tmp_path / "repo"
    (root / "fixtures" / "directory").mkdir(parents=True)
    shutil.copy(find_repo_root() / "fixtures" / "world.yaml", root / "fixtures" / "world.yaml")
    sources = root / "fixtures" / "corpus" / "sources" / "kestrel"
    sources.mkdir(parents=True)
    (sources / "exec-report.md").write_text(REPORT, encoding="utf-8")
    (sources / "hr-leave-policy.md").write_text(POLICY, encoding="utf-8")
    monkeypatch.setattr(cli, "_root", lambda: root)
    monkeypatch.setattr(fixtures, "ENDPOINTS", fixtures.Endpoints(server.url))
    return root


def ex(*args: str, ok: bool = True) -> Any:
    result = runner.invoke(cli.app, ["fixtures", *args, "--json"])
    assert (result.exit_code == 0) is ok, result.output
    return json.loads(result.stdout)


def test_it_builds_everything_and_resets_fake_workspace(
    repo: Path, server: Server, stack: FakeStack
) -> None:
    out = ex()
    assert set(out) == {"directory", "corpus", "workspace", "duration_s"}
    assert out["directory"] == {
        "changed": [
            "fixtures/directory/kestrel-realm.json",
            "fixtures/directory/harbour-realm.json",
        ],
        "recreated": ["keycloak", "envoy"],
        "detail": "recreated keycloak and envoy to load the new realm exports",
    }
    assert stack.calls == ["recreate keycloak", "recreate envoy"]
    corpus = out["corpus"]
    assert {k: corpus[k] for k in ("documents", "rendered", "reused")} == {
        "documents": 2,
        "rendered": 2,
        "reused": 0,
    }
    build = repo / "fixtures" / "corpus" / "build"
    assert corpus["bytes"] == sum(p.stat().st_size for p in (build / "blobs").iterdir())
    assert len(corpus["manifest_sha256"]) == 64
    assert out["workspace"] == {"reset": True, "detail": "fake-workspace reloaded the corpus"}
    assert ("POST", "/_control/reset") in server.requests
    assert isinstance(out["duration_s"], float)


def test_a_second_run_reuses_the_build_and_leaves_the_realms(repo: Path, stack: FakeStack) -> None:
    first = ex()
    stack.calls.clear()
    second = ex()
    assert second["directory"] == {"changed": [], "recreated": [], "detail": None}
    assert stack.calls == []
    assert (second["corpus"]["rendered"], second["corpus"]["reused"]) == (0, 2)
    assert second["corpus"]["manifest_sha256"] == first["corpus"]["manifest_sha256"]


def test_clean_renders_everything_again(repo: Path) -> None:
    ex()
    assert ex("--clean")["corpus"]["rendered"] == 2


@pytest.mark.parametrize("states", [{}, {"api": "running"}], ids=["no stack", "no keycloak"])
def test_nothing_to_reload_without_keycloak(
    repo: Path, monkeypatch: pytest.MonkeyPatch, stack: FakeStack, states: dict[str, str]
) -> None:
    stack.states = states
    monkeypatch.setattr(fixtures, "ENDPOINTS", fixtures.Endpoints(closed_url()))
    out = ex()
    assert out["directory"]["recreated"] == []
    assert out["directory"]["detail"] is None
    assert stack.calls == []
    assert out["workspace"]["reset"] is False
    assert "isn't running" in out["workspace"]["detail"]
    # The Keycloak that `ex up` creates next imports these exports, so nothing is left pending.
    stack.states = {"keycloak": "running"}
    assert ex()["directory"]["recreated"] == []
    assert stack.calls == []


def test_without_docker_the_reload_waits_for_a_later_run(repo: Path, stack: FakeStack) -> None:
    stack.status_error = services.DockerMissingError("docker is not on PATH")
    out = ex()
    assert out["directory"]["recreated"] == []
    assert "docker isn't on PATH" in out["directory"]["detail"]
    stack.status_error = None
    assert ex()["directory"]["recreated"] == ["keycloak", "envoy"]


def test_a_failed_status_fails_and_leaves_the_reload_pending(
    repo: Path, server: Server, stack: FakeStack
) -> None:
    daemon = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n"
    stack.status_error = ExError("docker compose ps --all --format json failed", detail=daemon)
    out = ex(ok=False)
    assert out["directory"]["recreated"] == []
    assert out["directory"]["detail"] == (
        "couldn't read the stack's status, so the realms weren't reloaded: "
        "docker compose ps --all --format json failed: " + daemon.strip()
    )
    assert out["workspace"]["reset"] is True
    assert stack.calls == []
    stack.status_error = None
    retry = ex()
    assert (retry["directory"]["changed"], retry["directory"]["recreated"]) == (
        [],
        ["keycloak", "envoy"],
    )


def test_envoy_is_left_alone_when_it_isnt_running(repo: Path, stack: FakeStack) -> None:
    stack.states["envoy"] = "exited"
    assert ex()["directory"]["recreated"] == ["keycloak"]
    assert stack.calls == ["recreate keycloak"]


def test_a_stopped_keycloak_is_removed_so_up_imports_the_exports(
    repo: Path, stack: FakeStack
) -> None:
    stack.states["keycloak"] = "exited"
    out = ex()
    assert out["directory"]["recreated"] == []
    assert out["directory"]["detail"].startswith("removed the stopped Keycloak")
    assert stack.calls == ["remove keycloak"]


@pytest.mark.parametrize(("failing", "recreated"), [("keycloak", []), ("envoy", ["keycloak"])])
def test_a_failed_recreate_fails_but_still_resets_fake_workspace(
    repo: Path, server: Server, stack: FakeStack, failing: str, recreated: list[str]
) -> None:
    stack.fail = failing
    out = ex(ok=False)
    assert out["directory"]["recreated"] == recreated
    assert out["directory"]["detail"] == (
        f"couldn't reload the realms: docker compose up {failing} failed: unhealthy"
    )
    assert out["workspace"]["reset"] is True


@pytest.mark.parametrize("failing", ["keycloak", "envoy"])
def test_a_failed_reload_is_retried_on_the_next_run(
    repo: Path, stack: FakeStack, failing: str
) -> None:
    stack.fail = failing
    ex(ok=False)
    stack.fail = None
    stack.calls.clear()
    retry = ex()
    # The exports didn't change this time, but Keycloak never loaded them.
    assert retry["directory"]["changed"] == []
    assert retry["directory"]["recreated"] == ["keycloak", "envoy"]
    assert stack.calls == ["recreate keycloak", "recreate envoy"]
    stack.calls.clear()
    assert ex()["directory"] == {"changed": [], "recreated": [], "detail": None}
    assert stack.calls == []


def test_fake_workspace_refusing_the_reset_fails(repo: Path, server: Server) -> None:
    server.status = 403
    out = ex(ok=False)
    assert out["workspace"]["reset"] is False
    assert "HTTP 403" in out["workspace"]["detail"]
    assert out["corpus"]["documents"] == 2


def test_a_reset_that_hangs_up_fails(repo: Path, server: Server) -> None:
    server.hang_up = True
    out = ex(ok=False)
    assert out["workspace"]["reset"] is False
    assert out["workspace"]["detail"].startswith("fake-workspace didn't finish the reset")


def test_realm_exports_wait_for_the_corpus(repo: Path) -> None:
    """A failed build leaves the exports alone, so the next run still reports their change."""
    source = repo / "fixtures" / "corpus" / "sources" / "kestrel" / "exec-report.md"
    source.write_text(REPORT + "\nUp \u2192 down\n", encoding="utf-8")
    ex(ok=False)
    assert list((repo / "fixtures" / "directory").iterdir()) == []
    source.write_text(REPORT, encoding="utf-8")
    assert len(ex()["directory"]["changed"]) == 2


def test_verify_builds_twice_elsewhere(repo: Path, server: Server, stack: FakeStack) -> None:
    out = ex("--verify")
    assert set(out) == {"verify", "corpus", "duration_s"}
    # two realm exports, the manifest, the inputs record and two blobs
    assert out["verify"] == {"identical": True, "files": 6, "differences": []}
    assert out["corpus"]["rendered"] == 2
    assert not (repo / "fixtures" / "corpus" / "build").exists()
    assert list((repo / "fixtures" / "directory").iterdir()) == []
    assert server.requests == []
    assert stack.calls == []


def test_differences_name_every_kind(tmp_path: Path) -> None:
    first, second = tmp_path / "first", tmp_path / "second"
    files = {
        first / "same.json": b"{}",
        second / "same.json": b"{}",
        first / "blobs" / "a.pdf": b"a",
        second / "blobs" / "a.pdf": b"b",
        first / "extra.txt": b"x",
        second / "nested" / "missing.txt": b"y",
    }
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    assert fixtures._differences(first, second) == [  # pyright: ignore[reportPrivateUsage]
        "blobs/a.pdf: bytes differ",
        "extra.txt: only in the first build",
        "nested/missing.txt: only in the second build",
    ]
    assert fixtures._differences(first, first) == []  # pyright: ignore[reportPrivateUsage]


def test_verify_fails_when_the_builds_differ(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = fixtures._build  # pyright: ignore[reportPrivateUsage]
    builds: list[Path] = []

    def unstable(root: Path, directory: Path, corpus: Path, *, clean: bool = False) -> Any:
        result = build(root, directory, corpus, clean=clean)
        builds.append(corpus)
        if len(builds) == 2:  # as if the second build stamped the time into the manifest
            manifest = corpus / "manifest.json"
            manifest.write_bytes(manifest.read_bytes() + b" ")
        return result

    monkeypatch.setattr(fixtures, "_build", unstable)
    out = ex("--verify", ok=False)
    assert out["verify"]["identical"] is False
    assert out["verify"]["differences"] == ["corpus/manifest.json: bytes differ"]


def test_verify_and_clean_together_are_refused(repo: Path) -> None:
    out = ex("--verify", "--clean", ok=False)
    assert out["error"].startswith("--verify builds in temporary directories")


def test_source_problems_are_listed(repo: Path) -> None:
    source = repo / "fixtures" / "corpus" / "sources" / "kestrel" / "exec-report.md"
    source.write_text(REPORT.replace("amara.okafor", "nobody"), encoding="utf-8")
    out = ex(ok=False)
    assert out["error"] == "the corpus sources have problems"
    assert any("author nobody isn't a user in kestrel" in p for p in out["detail"])


def test_render_problems_are_listed(repo: Path) -> None:
    source = repo / "fixtures" / "corpus" / "sources" / "kestrel" / "exec-report.md"
    source.write_text(REPORT + "\nUp → down\n", encoding="utf-8")
    out = ex(ok=False)
    assert out["error"] == "some documents failed to render"
    (problem,) = out["detail"]
    assert problem.endswith("characters the Helvetica font can't set: '→' (U+2192)")


def test_a_missing_world_is_a_json_error(repo: Path) -> None:
    (repo / "fixtures" / "world.yaml").unlink()
    out = ex(ok=False)
    assert out["error"] == "can't read or write the fixtures"
    assert "world.yaml" in out["detail"]
