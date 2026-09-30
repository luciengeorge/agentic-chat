import difflib
import shutil
from dataclasses import dataclass
from pathlib import Path

from ac_ex import state
from ac_ex.catalog import Step
from ac_ex.errors import ExError

PLAYGROUND = Path("playground")


def playground(root: Path) -> Path:
    return root / PLAYGROUND


def require_active(root: Path, step: Step) -> None:
    active = state.read(root).active_step
    if active != step.id:
        raise ExError(
            f"step {step.id} isn't active (active: {active or 'none'})",
            detail=f"run `ex start {step.id}` first",
        )


def fill_playground(root: Path, source: Path, step: Step) -> list[str]:
    """Replace playground/ with the step's code files from `source`, flat. Tests aren't copied:
    `ex test` runs them from the problem dir, so editing a copy can't change the grade."""
    target = playground(root)
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    copied: list[str] = []
    for file in step.code_files(source):
        shutil.copy2(file, target / file.name)
        copied.append(file.name)
    return copied


def _snapshot(files: list[Path]) -> dict[str, bytes]:
    return {f.name: f.read_bytes() for f in files}


def has_changes(root: Path, step: Step) -> bool:
    """Whether playground/ holds work that matches neither the step's problem nor its solution."""
    ours = playground(root)
    if not ours.is_dir():
        return False
    current = _snapshot(step.files(ours))
    return all(
        current != _snapshot(step.code_files(d)) for d in (step.problem_dir, step.solution_dir)
    )


def activate(root: Path, step: Step) -> list[str]:
    copied = fill_playground(root, step.problem_dir, step)
    current = state.read(root)
    current.active_step = step.id
    state.write(root, current)
    return copied


def mark_passed(root: Path, step: Step) -> None:
    current = state.read(root)
    current.passed.append(step.id)
    state.write(root, current)


@dataclass(frozen=True)
class FileDiff:
    path: str
    changed: bool
    diff: str

    def to_json(self) -> dict[str, object]:
        return {"path": self.path, "changed": self.changed, "diff": self.diff}


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines(keepends=True) if path.is_file() else []


def diff(root: Path, step: Step) -> list[FileDiff]:
    """Playground against the solution, one entry per file in either."""
    ours = playground(root)
    names = sorted(
        {f.name for f in step.code_files(step.solution_dir)}
        | {f.name for f in (step.code_files(ours) if ours.is_dir() else [])}
    )
    result: list[FileDiff] = []
    for name in names:
        text = "".join(
            difflib.unified_diff(
                _lines(ours / name),
                _lines(step.solution_dir / name),
                fromfile=f"playground/{name}",
                tofile=f"solution/{name}",
            )
        )
        result.append(FileDiff(path=name, changed=bool(text), diff=text))
    return result
