import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from ac_ex import cli

runner = CliRunner()


@pytest.fixture(autouse=True)
def _in_repo(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "_root", lambda: repo)

    def after_switch(root: Path) -> cli.AfterSwitch:
        return cli.AfterSwitch(restarted=["workers"])

    monkeypatch.setattr(cli, "_after_switch", after_switch)


def ex(*args: str, ok: bool = True) -> Any:
    result = runner.invoke(cli.app, [*args, "--json"])
    assert (result.exit_code == 0) is ok, result.output
    return json.loads(result.stdout)


def test_list_hides_hidden_sections() -> None:
    assert ex("list") == {
        "sections": [
            {
                "id": "00",
                "slug": "tour",
                "title": "Tour",
                "hidden": False,
                "steps": [
                    {
                        "id": "00.1",
                        "slug": "run",
                        "title": "Run",
                        "type": "guided",
                        "problem_dir": "exercises/00.tour/01.problem.run",
                        "solution_dir": "exercises/00.tour/01.solution.run",
                        "status": "not_started",
                    }
                ],
            }
        ]
    }


def test_list_all() -> None:
    assert [s["id"] for s in ex("list", "--all")["sections"]] == ["00", "_smoke"]


def test_start_copies_problem_files_and_sets_state(repo: Path) -> None:
    out = ex("start", "_smoke.1")
    assert out == {
        "step": "_smoke.1",
        "files": ["greeting.py", "test_greeting.py"],
        "already_active": False,
        "restarted": ["workers"],
        "terminated": [],
        "skipped": [],
    }
    assert sorted(p.name for p in (repo / "playground").iterdir()) == [
        "greeting.py",
        "test_greeting.py",
    ]
    state = json.loads((repo / ".ex" / "state.json").read_text())
    assert state == {"active_step": "_smoke.1", "passed": []}


def test_start_again_keeps_your_work(repo: Path) -> None:
    ex("start", "_smoke.1")
    (repo / "playground" / "greeting.py").write_text("mine")
    assert ex("start", "_smoke.1")["already_active"] is True
    assert (repo / "playground" / "greeting.py").read_text() == "mine"
    ex("reset", "_smoke.1")
    assert "NotImplementedError" in (repo / "playground" / "greeting.py").read_text()


def test_start_another_step_clears_the_playground(repo: Path) -> None:
    ex("start", "_smoke.1")
    ex("start", "00.1")
    assert list((repo / "playground").iterdir()) == []


def test_status_moves_through_active_and_passed(repo: Path) -> None:
    def status() -> str:
        steps = ex("list", "--all")["sections"][1]["steps"]
        return steps[0]["status"]

    assert status() == "not_started"
    ex("start", "_smoke.1")
    assert status() == "active"
    ex("solution", "_smoke.1")
    ex("test", "_smoke.1")
    ex("start", "00.1")
    assert status() == "passed"


def test_test_problem_fails() -> None:
    out = ex("test", "_smoke.1", "--target", "problem", ok=False)
    assert out["step"] == "_smoke.1"
    assert out["target"] == "problem"
    assert out["passed"] is False
    (only,) = out["tests"]
    assert only["nodeid"].endswith("test_greeting.py::test_greet")
    assert only["outcome"] == "failed"
    assert "NotImplementedError" in only["message"]


def test_test_solution_passes() -> None:
    out = ex("test", "_smoke.1", "--target", "solution")
    assert out["passed"] is True
    assert [t["outcome"] for t in out["tests"]] == ["passed"]


def test_test_playground_needs_the_step_active() -> None:
    out = ex("test", "_smoke.1", ok=False)
    assert out["error"] == "step _smoke.1 isn't active (active: none)"


def test_test_guided_step_is_an_error() -> None:
    assert "guided step" in str(ex("test", "00.1", ok=False)["error"])


def test_diff(repo: Path) -> None:
    ex("start", "_smoke.1")
    files = {f["path"]: f for f in ex("diff", "_smoke.1")["files"]}
    assert files["greeting.py"]["changed"] is True
    assert "+    return f'hello {name}'" in files["greeting.py"]["diff"]
    assert files["test_greeting.py"]["changed"] is False
    ex("solution", "_smoke.1")
    assert not any(f["changed"] for f in ex("diff", "_smoke.1")["files"])


def test_gate(repo: Path) -> None:
    out = ex("gate")
    assert out["passed"] is True
    (step,) = out["steps"]
    assert step["step"] == "_smoke.1"
    assert step["problem"]["passed"] is False
    assert step["solution"]["passed"] is True


def test_gate_catches_a_problem_that_already_passes(repo: Path) -> None:
    solution = repo / "exercises/_smoke/01.solution.greeting/greeting.py"
    (repo / "exercises/_smoke/01.problem.greeting/greeting.py").write_text(solution.read_text())
    out = ex("gate", ok=False)
    assert out["steps"][0]["reasons"] == ["problem tests pass; they grade nothing"]


def test_gate_catches_a_missing_slot_file(repo: Path) -> None:
    (repo / "exercises/_smoke/01.solution.greeting/greeting.py").unlink()
    out = ex("gate", ok=False)
    reasons = out["steps"][0]["reasons"]
    assert reasons == ["exercises/_smoke/01.solution.greeting is missing slot file greeting.py"]


def test_fixtures_is_m0b() -> None:
    assert ex("fixtures", ok=False) == {
        "error": "ex fixtures is not implemented until M0b",
        "detail": {"milestone": "M0b"},
    }


def test_unknown_step_is_a_json_error() -> None:
    out = ex("start", "42.1", ok=False)
    assert out == {"error": "no step 42.1", "detail": "run `ex list --all` to see every step"}


def test_record_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert "OPENAI_API_KEY" in str(ex("record", ok=False)["error"])
