from pathlib import Path

import pytest

from ac_ex import catalog
from ac_ex.errors import ExError


def test_load(repo: Path) -> None:
    tour, smoke = catalog.load(repo)
    assert (tour.id, tour.slug, tour.title, tour.hidden) == ("00", "tour", "Tour", False)
    assert [(s.id, s.type, s.hidden) for s in tour.steps] == [("00.1", "guided", False)]
    assert (smoke.id, smoke.slug, smoke.hidden) == ("_smoke", "smoke", True)
    (step,) = smoke.steps
    assert (step.id, step.type, step.hidden) == ("_smoke.1", "graded", True)
    assert step.slots == {"exrefpkg.greeting": "greeting.py"}
    assert [f.name for f in step.files(step.problem_dir)] == ["greeting.py", "test_greeting.py"]


def test_find(repo: Path) -> None:
    assert catalog.find(repo, "_smoke.1").slug == "greeting"
    with pytest.raises(ExError, match=r"no step 00\.9"):
        catalog.find(repo, "00.9")


def test_step_without_solution(repo: Path) -> None:
    (repo / "exercises" / "00.tour" / "02.problem.lonely").mkdir()
    (repo / "exercises" / "00.tour" / "02.problem.lonely" / "README.mdx").write_text("")
    with pytest.raises(ExError, match="no matching solution"):
        catalog.load(repo)


def test_bad_step_type(repo: Path) -> None:
    readme = repo / "exercises" / "00.tour" / "01.problem.run" / "README.mdx"
    readme.write_text("---\ntype: quiz\n---\n")
    with pytest.raises(ExError, match="type must be one of"):
        catalog.load(repo)


def test_no_exercises(tmp_path: Path) -> None:
    assert catalog.load(tmp_path) == []
