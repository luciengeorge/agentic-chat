import json
import shutil
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from ac_core.slots import find_repo_root
from ac_ex import cli, fixtures

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


@pytest.fixture
def server() -> Iterator[Server]:
    running = Server()
    yield running
    running.close()


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, server: Server) -> Path:
    """A repo with the real world, two sources, and fake-workspace and Keycloak both up."""
    root = tmp_path / "repo"
    (root / "fixtures" / "directory").mkdir(parents=True)
    shutil.copy(find_repo_root() / "fixtures" / "world.yaml", root / "fixtures" / "world.yaml")
    sources = root / "fixtures" / "corpus" / "sources" / "kestrel"
    sources.mkdir(parents=True)
    (sources / "exec-report.md").write_text(REPORT, encoding="utf-8")
    (sources / "hr-leave-policy.md").write_text(POLICY, encoding="utf-8")
    monkeypatch.setattr(cli, "_root", lambda: root)
    monkeypatch.setattr(fixtures, "ENDPOINTS", fixtures.Endpoints(server.url, server.url))
    return root


def ex(*args: str, ok: bool = True) -> Any:
    result = runner.invoke(cli.app, ["fixtures", *args, "--json"])
    assert (result.exit_code == 0) is ok, result.output
    return json.loads(result.stdout)


def test_it_builds_everything_and_resets_fake_workspace(repo: Path, server: Server) -> None:
    out = ex()
    assert set(out) == {"directory", "corpus", "workspace", "duration_s"}
    assert out["directory"] == {
        "changed": [
            "fixtures/directory/kestrel-realm.json",
            "fixtures/directory/harbour-realm.json",
        ],
        "detail": fixtures.KEYCLOAK_RECREATE,
    }
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


def test_a_second_run_reuses_the_build_and_leaves_the_realms(repo: Path) -> None:
    first = ex()
    second = ex()
    assert second["directory"] == {"changed": [], "detail": None}
    assert (second["corpus"]["rendered"], second["corpus"]["reused"]) == (0, 2)
    assert second["corpus"]["manifest_sha256"] == first["corpus"]["manifest_sha256"]


def test_clean_renders_everything_again(repo: Path) -> None:
    ex()
    assert ex("--clean")["corpus"]["rendered"] == 2


def test_no_keycloak_means_no_recreate_note(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fixtures, "ENDPOINTS", fixtures.Endpoints(closed_url(), closed_url()))
    out = ex()
    assert out["directory"]["detail"] is None
    assert out["workspace"]["reset"] is False
    assert "isn't running" in out["workspace"]["detail"]


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


def test_verify_builds_twice_elsewhere(repo: Path, server: Server) -> None:
    out = ex("--verify")
    assert set(out) == {"verify", "corpus", "duration_s"}
    # two realm exports, the manifest, the inputs record and two blobs
    assert out["verify"] == {"identical": True, "files": 6, "differences": []}
    assert out["corpus"]["rendered"] == 2
    assert not (repo / "fixtures" / "corpus" / "build").exists()
    assert list((repo / "fixtures" / "directory").iterdir()) == []
    assert server.requests == []


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
