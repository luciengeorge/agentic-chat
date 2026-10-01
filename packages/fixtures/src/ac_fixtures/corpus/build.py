"""The corpus build: every source rendered into a content-addressed blob, then manifest.json.

A document is re-rendered only when its input hash changes. The hash covers the source and the
world as parsed, and the renderer: this package's code, the world and source loaders, the
vendored font, and the versions of Python, zlib and the libraries that write the bytes.
`inputs.json` records it.
"""

import hashlib
import json
import os
import platform
import shutil
import zlib
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from importlib import metadata
from multiprocessing import get_context
from pathlib import Path
from typing import Any

from ac_core.slots import find_repo_root
from ac_fixtures.corpus import blocks, pdf
from ac_fixtures.corpus.manifest import Blob, build_manifest, dumps, file_times
from ac_fixtures.corpus.render import Document, Rendered, render
from ac_fixtures.sources import EXTENSIONS, Source, load_sources
from ac_fixtures.world import World, default_world_path, load_world

MANIFEST = "manifest.json"
INPUTS = "inputs.json"
BLOBS = "blobs"
LIBRARIES = (
    "lxml",
    "markdown-it-py",
    "numpy",
    "pillow",
    "pypdfium2",
    "python-docx",
    "reportlab",
)
# Rendered first, so the slow documents don't hold up the end of a parallel build.
_COST = {"generated": 0, "scan": 1, "handwriting": 1, "pdf_mixed": 1}


class CorpusError(Exception):
    def __init__(self, problems: list[str]) -> None:
        self.problems = tuple(problems)
        super().__init__("\n".join(problems))


@dataclass(frozen=True)
class BuildReport:
    documents: int
    rendered: int
    reused: int
    bytes: int
    manifest_sha256: str

    def to_json(self) -> dict[str, object]:
        return {
            "documents": self.documents,
            "rendered": self.rendered,
            "reused": self.reused,
            "bytes": self.bytes,
            "manifest_sha256": self.manifest_sha256,
        }


def default_build_dir() -> Path:
    return find_repo_root() / "fixtures" / "corpus" / "build"


def build(
    out: Path | None = None,
    *,
    world_path: Path | None = None,
    sources_root: Path | None = None,
    jobs: int | None = None,
) -> BuildReport:
    out = out or default_build_dir()
    world_path = world_path or default_world_path()
    world = load_world(world_path)
    sources = load_sources(world, sources_root)
    renderer = renderer_fingerprint()
    world_sha = _sha256(world.model_dump_json().encode())
    previous = _read_inputs(out)

    inputs: dict[str, dict[str, Any]] = {}
    blobs: dict[str, Blob] = {}
    to_render: list[tuple[str, Source, Document]] = []
    for source in sources:
        key = f"{source.tenant}/{source.meta.id}"
        digest = _sha256(
            json.dumps(
                {
                    "renderer": renderer,
                    "world": world_sha,
                    "source": _sha256(source.model_dump_json(exclude={"file"}).encode()),
                },
                sort_keys=True,
            ).encode()
        )
        inputs[key] = {"input_sha256": digest}
        reusable = _reusable(out, previous.get(key), digest)
        if reusable is not None:
            blobs[key] = reusable
        else:
            to_render.append((key, source, document(world, source)))

    rendered = _render_all([doc for _, _, doc in to_render], jobs)
    problems: list[str] = []
    for (key, source, _), result in zip(to_render, rendered, strict=True):
        if isinstance(result, str):
            problems.append(f"{source.file}: {result}")
        else:
            blobs[key] = _write_blob(out, result, EXTENSIONS[source.meta.format])

    for key, blob in blobs.items():
        inputs[key].update(
            blob=blob.path,
            sha256=blob.sha256,
            size=blob.size,
            mime_type=blob.mime_type,
            pages=blob.pages,
        )
    # Recorded even when some documents failed, so the next build reuses the ones that didn't.
    _write(out / INPUTS, (json.dumps(inputs, indent=2, sort_keys=True) + "\n").encode())
    if problems:
        raise CorpusError(problems)
    manifest = dumps(build_manifest(world, sources, blobs))
    _write(out / MANIFEST, manifest)
    _prune(out, {blob.path for blob in blobs.values()})
    return BuildReport(
        documents=len(sources),
        rendered=len(to_render),
        reused=len(sources) - len(to_render),
        bytes=sum(blob.size for blob in blobs.values()),
        manifest_sha256=_sha256(manifest),
    )


def document(world: World, source: Source) -> Document:
    meta = source.meta
    created, modified = file_times(source.tenant, meta.id, meta.created, meta.modified)
    return Document(
        key=f"{source.tenant}/{meta.id}",
        format=meta.format,
        title=meta.title,
        author=world.tenants[source.tenant].user(meta.author).name,
        created=created,
        modified=modified,
        body=source.body,
        generator=meta.generator,
        pages=meta.pages,
        seed=meta.seed,
    )


def renderer_fingerprint() -> str:
    digest = hashlib.sha256()
    package = Path(__file__).parent
    code = [
        *sorted(package.glob("*.py")),
        package.parent / "world.py",
        package.parent / "sources.py",
    ]
    for path in [*code, pdf.font_path()]:
        digest.update(path.name.encode() + b"\0" + path.read_bytes() + b"\0")
    for library in LIBRARIES:
        digest.update(f"{library}=={metadata.version(library)}\0".encode())
    digest.update(f"python {platform.python_version()} zlib {zlib.ZLIB_RUNTIME_VERSION}".encode())
    return digest.hexdigest()


def clean(out: Path | None = None) -> None:
    shutil.rmtree(out or default_build_dir(), ignore_errors=True)


def _render_all(docs: list[Document], jobs: int | None) -> list[Rendered | str]:
    workers = min(jobs or os.cpu_count() or 1, len(docs))
    if workers <= 1:
        return [_render_one(doc) for doc in docs]
    order = sorted(range(len(docs)), key=lambda i: _COST.get(docs[i].format, 2))
    with ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn")) as pool:
        futures: dict[int, Future[Rendered | str]] = {
            i: pool.submit(_render_one, docs[i]) for i in order
        }
        return [futures[i].result() for i in range(len(docs))]


def _render_one(doc: Document) -> Rendered | str:
    """The rendered document, or what went wrong, so one bad source can't hide the others."""
    try:
        return render(doc)
    except blocks.RenderError as exc:
        return str(exc)
    except Exception as exc:  # a library refusing the content, e.g. lxml on a control character
        return f"{type(exc).__name__}: {exc}"


def _reusable(out: Path, entry: dict[str, Any] | None, digest: str) -> Blob | None:
    if entry is None or entry.get("input_sha256") != digest:
        return None
    try:
        blob = Blob(
            path=entry["blob"],
            sha256=entry["sha256"],
            size=entry["size"],
            mime_type=entry["mime_type"],
            pages=entry["pages"],
        )
        data = (out / blob.path).read_bytes()
    except (KeyError, OSError):
        return None
    return blob if _sha256(data) == blob.sha256 and len(data) == blob.size else None


def _read_inputs(out: Path) -> dict[str, dict[str, Any]]:
    try:
        return json.loads((out / INPUTS).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_blob(out: Path, rendered: Rendered, extension: str) -> Blob:
    sha = _sha256(rendered.data)
    path = f"{BLOBS}/{sha}{extension}"
    _write(out / path, rendered.data)
    return Blob(path, sha, len(rendered.data), rendered.mime_type, rendered.pages)


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f".{path.name}.partial")
    partial.write_bytes(data)
    partial.replace(path)


def _prune(out: Path, keep: set[str]) -> None:
    for path in (out / BLOBS).iterdir() if (out / BLOBS).is_dir() else ():
        if f"{BLOBS}/{path.name}" not in keep:
            path.unlink()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
