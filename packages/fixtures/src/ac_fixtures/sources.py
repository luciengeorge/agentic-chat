"""Document sources: `fixtures/corpus/sources/<tenant>/<id>.md`, frontmatter then a markdown body.

`python -m ac_fixtures.sources` validates every source against the world and prints a summary,
or every problem it found (exit 1).
"""

import re
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from datetime import date
from pathlib import Path
from typing import Literal

from markdown_it import MarkdownIt
from markdown_it.token import Token
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from yaml import YAMLError

from ac_core.slots import find_repo_root
from ac_fixtures.world import (
    SLUG,
    Sharing,
    World,
    WorldError,
    load_world,
    load_yaml,
    validation_problems,
)

Format = Literal["pdf", "pdf_mixed", "scan", "handwriting", "docx", "md", "generated"]
Trap = Literal[
    "acl-leak",
    "tables",
    "ocr",
    "conflicting-sources",
    "prompt-injection",
    "lexical",
    "fan-out",
    "tenant-isolation",
]

EXTENSIONS: dict[Format, str] = {
    "pdf": ".pdf",
    "pdf_mixed": ".pdf",
    "scan": ".pdf",
    "handwriting": ".pdf",
    "generated": ".pdf",
    "docx": ".docx",
    "md": ".md",
}

# Each directive is an HTML comment alone on its line, at the top level of the body.
DIRECTIVES = (
    "pagebreak",
    "scan-begin",
    "scan-end",
    "hidden-begin",
    "hidden-end",
)
DIRECTIVE_FORMATS: dict[str, frozenset[Format]] = {
    "pagebreak": frozenset({"pdf", "pdf_mixed", "scan", "docx"}),
    "scan": frozenset({"pdf_mixed"}),
    "hidden": frozenset({"pdf", "pdf_mixed", "docx"}),
}
_LOOSE_DIRECTIVE = re.compile(r"<!--\s*(" + "|".join(DIRECTIVES) + r")\s*-->")
_FORBIDDEN_FILENAME_CHARS = set('/\\"*:<>?|')

_markdown = MarkdownIt("commonmark").enable("table")


class SourceError(Exception):
    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = tuple(problems)
        super().__init__("\n".join(self.problems))


class _Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class SourceMeta(_Model):
    id: str = Field(pattern=SLUG)
    title: str = Field(min_length=1)
    folder: str
    filename: str
    format: Format
    author: str
    created: date
    modified: date
    valid_from: date | None = None
    valid_to: date | None = None
    traps: tuple[Trap, ...] = ()
    permissions: Sharing | None = None
    generator: str | None = None
    pages: int | None = Field(default=None, ge=1)
    seed: int | None = None


class Source(_Model):
    tenant: str
    file: Path
    meta: SourceMeta
    body: str


def default_sources_root() -> Path:
    return find_repo_root() / "fixtures" / "corpus" / "sources"


def load_sources(world: World, root: Path | None = None) -> list[Source]:
    """Every source under `root`, by tenant then id; raises `SourceError` with every problem."""
    root = root or default_sources_root()
    if not root.is_dir():
        raise SourceError([f"{_show(root)}: no sources directory"])
    problems: list[str] = []
    sources: list[Source] = []
    for entry in _entries(root):
        if not entry.is_dir() or entry.name not in world.tenants:
            tenants = ", ".join(world.tenants)
            problems.append(f"{_show(entry)}: expected only tenant directories ({tenants})")
            continue
        for file in _entries(entry):
            if not file.is_file() or file.suffix != ".md":
                problems.append(f"{_show(file)}: expected only <id>.md source files here")
                continue
            source, file_problems = _load_source(world, entry.name, file)
            problems.extend(file_problems)
            if source is not None:
                sources.append(source)
    problems.extend(_collisions(world, sources))
    if problems:
        raise SourceError(problems)
    return sources


def _entries(directory: Path) -> list[Path]:
    return sorted(p for p in directory.iterdir() if not p.name.startswith("."))


def _load_source(world: World, tenant: str, file: Path) -> tuple[Source | None, list[str]]:
    shown = _show(file)
    text = file.read_text(encoding="utf-8")
    lines = text.split("\n")
    if lines[0].rstrip() != "---":
        return None, [f"{shown}: must start with a --- frontmatter block"]
    end = next((i for i, line in enumerate(lines[1:], 1) if line.rstrip() == "---"), None)
    if end is None:
        return None, [f"{shown}: the frontmatter has no closing ---"]
    try:
        data = load_yaml("\n".join(lines[1:end]))
    except YAMLError as exc:
        return None, [f"{shown}: the frontmatter isn't valid YAML: {exc}"]
    if not isinstance(data, dict):
        return None, [f"{shown}: the frontmatter must be a mapping"]
    try:
        meta = SourceMeta.model_validate(data)
    except ValidationError as exc:
        return None, [f"{shown}: {problem}" for problem in validation_problems(exc)]

    body = "\n".join(lines[end + 1 :])
    problems = [f"{shown}: {problem}" for problem in _meta_problems(world, tenant, file, meta)]
    if meta.format != "generated" and not body.strip():
        problems.append(f"{shown}: the body is empty")
    problems.extend(
        f"{shown}:{line}: {problem}"
        for line, problem in _body_problems(body, meta.format, first_line=end + 2)
    )
    return Source(tenant=tenant, file=file, meta=meta, body=body), problems


def _meta_problems(world: World, tenant: str, file: Path, meta: SourceMeta) -> list[str]:
    spec = world.tenants[tenant]
    problems: list[str] = []
    if meta.id != file.stem:
        problems.append(f"id {meta.id} must equal the file name {file.stem}")
    if meta.folder not in {folder.path for folder in spec.folders}:
        problems.append(f"folder {meta.folder} isn't a folder in world.yaml")

    name = meta.filename
    if name != name.strip() or any(c in _FORBIDDEN_FILENAME_CHARS for c in name):
        problems.append(f"filename {name!r} has padding or a character SharePoint refuses")
    extension = EXTENSIONS[meta.format]
    if not name.endswith(extension) or name == extension:
        problems.append(f"filename {name!r} must end in {extension} for format {meta.format}")

    if meta.author not in {user.username for user in spec.users}:
        problems.append(f"author {meta.author} isn't a user in {tenant}")
    for field, value in (("created", meta.created), ("modified", meta.modified)):
        if value > world.today:
            problems.append(f"{field} {value} is after world.today {world.today}")
    if meta.created > meta.modified:
        problems.append(f"created {meta.created} is after modified {meta.modified}")
    if meta.valid_from and meta.valid_to and meta.valid_from > meta.valid_to:
        problems.append(f"valid_from {meta.valid_from} is after valid_to {meta.valid_to}")

    generated = {"generator": meta.generator, "pages": meta.pages, "seed": meta.seed}
    if meta.format == "generated":
        if missing := [key for key, value in generated.items() if value is None]:
            problems.append(f"format generated needs {', '.join(missing)}")
    elif present := [key for key, value in generated.items() if value is not None]:
        problems.append(f"{', '.join(present)} only go with format generated")
    if meta.permissions is not None:
        problems.extend(
            f"permissions: {problem}" for problem in spec.grant_problems(meta.permissions.grants)
        )
    return problems


def _body_problems(body: str, fmt: Format, first_line: int) -> list[tuple[int, str]]:
    """Directive and markup problems as (file line, message)."""
    problems: list[tuple[int, str]] = []
    directives: list[tuple[int, str]] = []
    for token in _markdown.parse(body):
        line = first_line + (token.map[0] if token.map else 0)
        if token.type == "html_block":
            content = token.content.strip()
            name = _directive_name(content)
            if name is None:
                problems.append((line, _html_problem(content)))
            elif token.level > 0:
                problems.append((line, f"<!-- {name} --> must sit at the top level of the body"))
            else:
                directives.append((line, name))
        elif token.type == "inline":
            problems.extend((line, problem) for problem in _inline_problems(token.children or []))
    problems.extend(_directive_problems(directives, fmt))
    return problems


def _directive_name(content: str) -> str | None:
    for name in DIRECTIVES:
        if content == f"<!-- {name} -->":
            return name
    return None


def _html_problem(html: str) -> str:
    if match := _LOOSE_DIRECTIVE.search(html):
        return f"<!-- {match[1]} --> must be written exactly so, alone on its line"
    return f"raw HTML isn't allowed: {html.splitlines()[0][:60]!r}"


def _inline_problems(tokens: Iterable[Token]) -> list[str]:
    problems: list[str] = []
    for token in tokens:
        if token.type == "image":
            problems.append("images aren't allowed")
        elif token.type == "html_inline":
            problems.append(_html_problem(token.content))
        problems.extend(_inline_problems(token.children or []))
    return problems


def _directive_problems(directives: list[tuple[int, str]], fmt: Format) -> list[tuple[int, str]]:
    problems: list[tuple[int, str]] = []
    region: tuple[str, int] | None = None
    for line, name in directives:
        kind = name.removesuffix("-begin").removesuffix("-end")
        if fmt not in DIRECTIVE_FORMATS[kind]:
            allowed = ", ".join(sorted(DIRECTIVE_FORMATS[kind]))
            problems.append((line, f"<!-- {name} --> isn't allowed in {fmt} (only {allowed})"))
        if name == "pagebreak":
            if region is not None and region[0] == "hidden":
                problems.append((line, f"pagebreak inside the hidden region from line {region[1]}"))
        elif name.endswith("-begin"):
            if region is not None:
                problems.append(
                    (line, f"{name} inside the {region[0]} region from line {region[1]}")
                )
            else:
                region = (kind, line)
        elif region is None or region[0] != kind:
            problems.append((line, f"{name} has no matching {kind}-begin"))
        else:
            region = None
    if region is not None:
        problems.append((region[1], f"{region[0]}-begin is never closed"))
    return problems


def _collisions(world: World, sources: Sequence[Source]) -> list[str]:
    """Item paths must be unique, ignoring case as SharePoint does, and not shadow a folder."""
    problems: list[str] = []
    for tenant, spec in world.tenants.items():
        taken = {folder.path.casefold(): f"folder {folder.path}" for folder in spec.folders}
        for source in sources:
            if source.tenant != tenant:
                continue
            path = f"{source.meta.folder}/{source.meta.filename}"
            other = taken.get(path.casefold())
            if other is not None:
                problems.append(f"{_show(source.file)}: {path} clashes with {other}")
            else:
                taken[path.casefold()] = _show(source.file)
    return problems


def _show(path: Path) -> str:
    try:
        return str(path.relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def summary(world: World, sources: Sequence[Source]) -> str:
    lines: list[str] = []
    for tenant in world.tenants:
        mine = [source for source in sources if source.tenant == tenant]
        formats = Counter(source.meta.format for source in mine)
        traps = Counter(trap for source in mine for trap in source.meta.traps)
        lines += [
            f"{tenant}: {_plural(len(mine), 'source')}",
            f"  formats: {_counts(formats)}",
            f"  traps: {_counts(traps)}",
        ]
    lines.append(f"total: {_plural(len(sources), 'source')}")
    return "\n".join(lines)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def _counts(counter: Counter[str]) -> str:
    return ", ".join(f"{name} {count}" for name, count in sorted(counter.items())) or "none"


def main() -> int:
    try:
        world = load_world()
        sources = load_sources(world)
    except (WorldError, SourceError) as exc:
        print(f"{_plural(len(exc.problems), 'problem')}:", file=sys.stderr)
        for problem in exc.problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print(summary(world, sources))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
