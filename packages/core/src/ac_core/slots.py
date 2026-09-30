"""Swap a step's learnable modules for the learner's copies at import time.

A step's README.mdx frontmatter maps module names to files. `install()` resolves
the active step once, then loads just those modules from the slot root
(`playground/` by default); every other import is untouched. See PLAN.md,
"Slots vs Temporal", for why this happens once per process and never again.
"""

import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import cast

import yaml

SECTION_DIR = re.compile(r"^(?P<id>\d{2}|_[a-z0-9-]+)(?:\.(?P<slug>[a-z0-9-]+))?$")
STEP_DIR = re.compile(r"^(?P<num>\d{2})\.(?P<kind>problem|solution)\.(?P<slug>[a-z0-9-]+)$")
STEP_ID = re.compile(r"^(?P<section>\d{2}|_[a-z0-9-]+)\.(?P<num>\d+)$")

STATE_FILE = Path(".ex/state.json")
DEFAULT_SLOT_ROOT = "playground"


class SlotError(Exception):
    pass


def find_repo_root() -> Path:
    """The workspace root: the nearest ancestor holding `exercises/` and `pyproject.toml`."""
    for start in (Path(__file__).resolve(), Path.cwd().resolve()):
        for candidate in (start, *start.parents):
            if (candidate / "exercises").is_dir() and (candidate / "pyproject.toml").is_file():
                return candidate
    raise SlotError("can't find the repo root (a directory with exercises/ and pyproject.toml)")


def read_frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    parts = text.split("\n---", 1)
    if len(parts) != 2:
        raise SlotError(f"{path}: frontmatter has no closing ---")
    data = yaml.safe_load(parts[0].removeprefix("---"))
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise SlotError(f"{path}: frontmatter must be a mapping")
    return cast(dict[str, object], data)


def find_step_dir(root: Path, step_id: str, kind: str = "problem") -> Path:
    """`09.2` -> exercises/09.<slug>/02.<kind>.<slug>."""
    match = STEP_ID.match(step_id)
    if match is None:
        raise SlotError(f"bad step id {step_id!r}; expected <section>.<step>, like 09.2")
    section_id, num = match["section"], int(match["num"])
    exercises = root / "exercises"
    for section in sorted(exercises.iterdir()) if exercises.is_dir() else []:
        section_match = SECTION_DIR.match(section.name)
        if not section.is_dir() or section_match is None or section_match["id"] != section_id:
            continue
        for step in sorted(section.iterdir()):
            step_match = STEP_DIR.match(step.name)
            if (
                step.is_dir()
                and step_match is not None
                and step_match["kind"] == kind
                and int(step_match["num"]) == num
            ):
                return step
    raise SlotError(f"no {kind} directory for step {step_id}")


def read_slots(readme: Path) -> dict[str, str]:
    raw = read_frontmatter(readme).get("slots")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise SlotError(f"{readme}: slots must map module names to file names")
    slots: dict[str, str] = {}
    for module, file in cast(dict[object, object], raw).items():
        if not isinstance(module, str) or not isinstance(file, str):
            raise SlotError(f"{readme}: slot {module!r} must map a module name to a file name")
        slots[module] = file
    return slots


def resolve_active_step(root: Path, environ: Mapping[str, str]) -> str | None:
    if step := environ.get("AC_ACTIVE_STEP"):
        return step
    state = root / STATE_FILE
    if not state.is_file():
        return None
    data: object = json.loads(state.read_text(encoding="utf-8"))
    step = cast(dict[str, object], data).get("active_step") if isinstance(data, dict) else None
    return step if isinstance(step, str) and step else None


def resolve_slot_root(root: Path, environ: Mapping[str, str]) -> Path:
    return root / environ.get("AC_SLOT_ROOT", DEFAULT_SLOT_ROOT)


@dataclass(frozen=True)
class Resolution:
    step: str | None
    slot_root: Path
    slots: Mapping[str, Path]


def resolve(root: Path, environ: Mapping[str, str]) -> Resolution:
    step = resolve_active_step(root, environ)
    slot_root = resolve_slot_root(root, environ)
    if step is None:
        return Resolution(step=None, slot_root=slot_root, slots={})
    readme = find_step_dir(root, step) / "README.mdx"
    slots = {module: slot_root / file for module, file in read_slots(readme).items()}
    return Resolution(step=step, slot_root=slot_root, slots=slots)


class SlotFinder(importlib.abc.MetaPathFinder):
    def __init__(self, resolution: Resolution) -> None:
        self.resolution = resolution

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        file = self.resolution.slots.get(fullname)
        if file is None:
            return None
        if not file.is_file():
            raise ModuleNotFoundError(
                f"step {self.resolution.step} slots {fullname} to {file}, which doesn't exist; "
                f"run `ex start {self.resolution.step}` or `ex reset {self.resolution.step}`",
                name=fullname,
            )
        return importlib.util.spec_from_file_location(fullname, file)


def installed() -> SlotFinder | None:
    return next((f for f in sys.meta_path if isinstance(f, SlotFinder)), None)


def install(root: Path | None = None, environ: Mapping[str, str] | None = None) -> Resolution:
    """Put the slot finder first on sys.meta_path. Later calls return the first resolution.

    Outside a checkout (a prod image ships no exercises) nothing is slotted, unless
    AC_ACTIVE_STEP asks for a step, which is an error.
    """
    if (finder := installed()) is not None:
        return finder.resolution
    environ = os.environ if environ is None else environ
    if root is None:
        try:
            root = find_repo_root()
        except SlotError:
            if environ.get("AC_ACTIVE_STEP"):
                raise
    resolution = (
        resolve(root, environ)
        if root is not None
        else Resolution(step=None, slot_root=Path(DEFAULT_SLOT_ROOT), slots={})
    )
    already = sorted(module for module in resolution.slots if module in sys.modules)
    if already:
        raise SlotError(f"install() ran after slot modules were imported: {', '.join(already)}")
    sys.meta_path.insert(0, SlotFinder(resolution))
    return resolution
