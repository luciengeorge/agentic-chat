from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ac_core.slots import SECTION_DIR, STEP_DIR, read_frontmatter, read_slots
from ac_ex.errors import ExError

StepType = Literal["graded", "guided", "lab"]
STEP_TYPES: tuple[StepType, ...] = ("graded", "guided", "lab")
IGNORED = {"README.mdx", "__pycache__", ".pytest_cache"}


@dataclass(frozen=True)
class Step:
    id: str
    slug: str
    title: str
    type: StepType
    hidden: bool
    problem_dir: Path
    solution_dir: Path
    slots: dict[str, str]

    def files(self, directory: Path) -> list[Path]:
        """The step's own files in a problem or solution dir, flat."""
        return sorted(p for p in directory.iterdir() if p.is_file() and p.name not in IGNORED)


@dataclass(frozen=True)
class Section:
    id: str
    slug: str
    title: str
    hidden: bool
    steps: list[Step]


def _title(meta: dict[str, object], fallback: str) -> str:
    title = meta.get("title")
    return title if isinstance(title, str) else fallback


def _load_step(section_id: str, section_hidden: bool, problem: Path, solution: Path) -> Step:
    match = STEP_DIR.match(problem.name)
    assert match is not None
    readme = problem / "README.mdx"
    if not readme.is_file():
        raise ExError(f"{problem} has no README.mdx")
    meta = read_frontmatter(readme)
    step_type = meta.get("type", "graded")
    if step_type not in STEP_TYPES:
        raise ExError(f"{readme}: type must be one of {', '.join(STEP_TYPES)}")
    return Step(
        id=f"{section_id}.{int(match['num'])}",
        slug=match["slug"],
        title=_title(meta, match["slug"]),
        type=step_type,
        hidden=section_hidden or meta.get("hidden") is True,
        problem_dir=problem,
        solution_dir=solution,
        slots=read_slots(readme),
    )


def _load_section(directory: Path) -> Section:
    match = SECTION_DIR.match(directory.name)
    assert match is not None
    readme = directory / "README.mdx"
    meta = read_frontmatter(readme) if readme.is_file() else {}
    hidden = meta.get("hidden") is True
    section_id = match["id"]
    slug = match["slug"] or section_id.lstrip("_")
    problems: dict[int, Path] = {}
    solutions: dict[int, Path] = {}
    for child in sorted(directory.iterdir()):
        step_match = STEP_DIR.match(child.name)
        if child.is_dir() and step_match is not None:
            target = problems if step_match["kind"] == "problem" else solutions
            target[int(step_match["num"])] = child
    steps: list[Step] = []
    for num, problem in sorted(problems.items()):
        solution = solutions.get(num)
        if solution is None:
            raise ExError(f"{problem} has no matching solution directory")
        steps.append(_load_step(section_id, hidden, problem, solution))
    return Section(id=section_id, slug=slug, title=_title(meta, slug), hidden=hidden, steps=steps)


def load(root: Path) -> list[Section]:
    exercises = root / "exercises"
    if not exercises.is_dir():
        return []
    sections = [
        _load_section(d)
        for d in sorted(exercises.iterdir())
        if d.is_dir() and SECTION_DIR.match(d.name)
    ]
    # Hidden sections (`_smoke`) sort after the numbered ones.
    return sorted(sections, key=lambda s: (s.id.startswith("_"), s.id))


def find(root: Path, step_id: str) -> Step:
    for section in load(root):
        for step in section.steps:
            if step.id == step_id:
                return step
    raise ExError(f"no step {step_id}", detail="run `ex list --all` to see every step")
