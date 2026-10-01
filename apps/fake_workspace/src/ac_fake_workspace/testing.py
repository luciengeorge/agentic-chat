"""Test support: a small corpus in the manifest's shape, a webhook receiver on localhost, and a
clock whose waits tests control."""

import asyncio
import hashlib
import json
import threading
import uuid
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Literal, Protocol
from urllib.parse import parse_qs, urlsplit

import httpx

from ac_fake_workspace.delivery import DeliveryPolicy
from ac_fake_workspace.state import Clock

NAMESPACE = uuid.UUID("2b0f5a64-0f6e-4c55-9f43-0d6d1c1d3f10")

USERS = {
    "kestrel": {
        "tom.whitfield": "Tom Whitfield",
        "marco.bianchi": "Marco Bianchi",
        "amara.okafor": "Amara Okafor",
    },
    "harbour": {"nina.osei": "Nina Osei"},
}
AUTHORS = {"kestrel": "tom.whitfield", "harbour": "nina.osei"}
ADMINS = {"kestrel": "amara.okafor", "harbour": "nina.osei"}  # the root's author, as in the build
GROUPS = {
    "kestrel": [
        "/Kestrel",
        "/Kestrel/Exec",
        "/Kestrel/Finance",
        "/Kestrel/Finance/FP&A",
        "/Kestrel/HR",
    ],
    "harbour": ["/Harbour"],
}

type OwnGrant = tuple[Literal["user", "group"], str, Literal["read", "write"]]

# (path, own grants, inherit), parents before children. /Company's files are out of order on
# purpose: children must come back sorted by name, case-insensitively.
TREE: dict[str, list[tuple[str, list[OwnGrant], bool]]] = {
    "kestrel": [
        ("/", [], False),
        ("/Company", [("group", "/Kestrel", "read")], True),
        ("/Company/echo.md", [], True),
        ("/Company/Bravo.md", [], True),
        ("/Company/alpha.md", [], True),
        ("/Company/Delta.md", [], True),
        ("/Company/charlie.md", [], True),
        ("/Exec", [("group", "/Kestrel/Exec", "write")], True),
        ("/Exec/Project Heron memo.pdf", [], True),
        (
            "/Finance",
            [("group", "/Kestrel/Finance", "read"), ("user", "tom.whitfield", "write")],
            True,
        ),
        ("/Finance/Reports", [("group", "/Kestrel/Exec", "read")], True),
        ("/Finance/Reports/Q3 report.pdf", [], True),
        ("/Finance/FP&A", [("group", "/Kestrel/Finance/FP&A", "write")], False),
        ("/Finance/FP&A/plan.md", [], True),
        ("/HR", [("group", "/Kestrel/HR", "write")], True),
        ("/HR/Casework", [], True),
        ("/HR/Casework/case note.pdf", [("user", "marco.bianchi", "read")], False),
    ],
    "harbour": [
        ("/", [], False),
        ("/Policies", [("group", "/Harbour", "read")], True),
        ("/Policies/expenses.pdf", [], True),
    ],
}

HOLD_S = 30.0  # the longest a held answer waits for its release

MIME = {".pdf": "application/pdf", ".md": "text/markdown"}

FAST = DeliveryPolicy(
    max_attempts=3,
    base_delay_s=0.01,
    max_delay_s=0.02,
    timeout_s=2.0,
    retry_timeout_s=2.0,
    validation_timeout_s=0.5,
)


class ManualClock(Clock):
    """Records every wait. A wait ends at once, or, while `gate` is set, when the gate opens (or
    the waiting task is cancelled), so a test can act while a delivery waits to retry."""

    def __init__(self) -> None:
        super().__init__()
        self.waits: list[float] = []
        self.gate: asyncio.Event | None = None

    async def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)
        if self.gate is not None:
            await self.gate.wait()


class MakeClient(Protocol):
    """Builds a fresh app, with its own in-memory state, and a client for it."""

    def __call__(
        self,
        *,
        corpus_dir: Path | None = None,
        env: Literal["dev", "test", "prod"] = "dev",
        token: str | None = "dev-workspace-kestrel",
        policy: DeliveryPolicy | None = None,
        clock: Clock | None = None,
    ) -> httpx.AsyncClient: ...


def uid(site: str, kind: str, name: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{site}:{kind}:{name}"))


@dataclass
class Corpus:
    dir: Path

    def id(self, site: str, path: str) -> str:
        return uid(site, "item", path)

    def user(self, site: str, username: str) -> str:
        return uid(site, "user", username)

    def group(self, site: str, path: str) -> str:
        return uid(site, "group", path)

    def content(self, site: str, path: str) -> bytes:
        return f"{site}:{path}\n".encode()

    def paths(self, site: str) -> list[str]:
        return [path for path, _, _ in TREE[site]]


def build_corpus(root: Path) -> Corpus:
    """Write `manifest.json` and its blobs for TREE into `root`."""
    corpus = Corpus(root)
    (root / "blobs").mkdir(parents=True, exist_ok=True)
    sites: dict[str, Any] = {}
    for site, tree in TREE.items():
        items: list[dict[str, Any]] = []
        for path, grants, inherit in tree:
            parent, _, name = path.rpartition("/")
            author = corpus.user(site, ADMINS[site] if path == "/" else AUTHORS[site])
            item: dict[str, Any] = {
                "id": corpus.id(site, path),
                "path": path,
                "name": name or "root",
                "parent_id": None if path == "/" else corpus.id(site, parent or "/"),
                "kind": "file" if "." in name else "folder",
                "created": "2026-09-01T09:00:00Z",
                "modified": "2026-09-02T10:30:00Z",
                "created_by": author,
                "modified_by": author,
                "sharing": {
                    "inherit": inherit,
                    "grants": [
                        {
                            "principal_type": kind,
                            "principal_id": uid(site, kind, principal),
                            "principal_name": principal,
                            "role": role,
                        }
                        for kind, principal, role in grants
                    ],
                },
            }
            if item["kind"] == "file":
                content = corpus.content(site, path)
                sha = hashlib.sha256(content).hexdigest()
                ext = Path(name).suffix
                (root / "blobs" / f"{sha}{ext}").write_bytes(content)
                item["file"] = {
                    "mime_type": MIME[ext],
                    "size": len(content),
                    "sha256": sha,
                    "blob": f"blobs/{sha}{ext}",
                }
                if ext == ".pdf":
                    item["file"]["pages"] = 1
                item |= {
                    "doc_id": name.lower().replace(" ", "-"),
                    "format": ext.removeprefix("."),
                    "traps": [],
                    "valid_from": None,
                    "valid_to": None,
                }
            items.append(item)
        users = {
            corpus.user(site, username): {"username": username, "display_name": display}
            for username, display in USERS[site].items()
        }
        groups = {corpus.group(site, path): {"path": path} for path in GROUPS[site]}
        sites[site] = {"items": items, "users": users, "groups": groups}
    manifest = {"version": 1, "sites": sites}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return corpus


@dataclass
class Receiver:
    """What a webhook endpoint on localhost received, and how it answers. A held answer waits
    for `release`, which the receiver sets as it shuts down."""

    url: str = ""
    # echo: the token as text/plain; html: the token as text/html; held: no answer until released
    validation: Literal["echo", "wrong", "empty", "html", "held"] = "echo"
    statuses: list[int] = field(default_factory=list[int])  # replies to notifications, then 202
    hold_notifications: bool = False
    release: threading.Event = field(default_factory=threading.Event)
    tokens: list[str] = field(default_factory=list[str])
    notifications: list[Any] = field(default_factory=list[Any])


@contextmanager
def serve_receiver() -> Generator[Receiver]:
    """A real HTTP server on a free localhost port, in a background thread."""
    rec = Receiver()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            query = parse_qs(urlsplit(self.path).query)
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if "validationToken" in query:
                token = query["validationToken"][0]
                rec.tokens.append(token)
                if rec.validation == "held":
                    rec.release.wait(HOLD_S)
                replies = {"wrong": token + "x", "empty": ""}
                kind = "text/html" if rec.validation == "html" else "text/plain"
                self.reply(200, replies.get(rec.validation, token).encode(), kind)
                return
            rec.notifications.append(json.loads(body))
            if rec.hold_notifications:
                rec.release.wait(HOLD_S)
            self.reply(rec.statuses.pop(0) if rec.statuses else 202, b"")

        def reply(self, status: int, body: bytes, kind: str = "text/plain") -> None:
            self.send_response(status)
            self.send_header("Content-Type", f"{kind}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request: Any, client_address: Any) -> None:
            pass  # e.g. a client that gave up on a slow validation answer

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    rec.url = f"http://127.0.0.1:{server.server_port}/hooks?tenant=kestrel"
    try:
        yield rec
    finally:
        rec.release.set()
        server.shutdown()
        server.server_close()
