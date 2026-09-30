import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from ac_ex import cli, services, state
from ac_ex.errors import ExError

runner = CliRunner()


class FakeServices:
    """The slot services and Temporal, recording each call with the active step at that moment."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.events: list[tuple[str, str | None]] = []
        self.running = ["workers"]
        self.terminate_error: Exception | None = None
        self.stop_error: Exception | None = None

    def _event(self, name: str) -> None:
        self.events.append((name, state.read(self.root).active_step))

    def switch(self) -> cli.SlotSwitch:
        def running(root: Path) -> list[str]:
            return list(self.running)

        def stop(root: Path, names: list[str]) -> None:
            self._event(f"stop {' '.join(names)}")
            if self.stop_error is not None:
                raise self.stop_error

        def start(root: Path, names: list[str]) -> None:
            self._event(f"start {' '.join(names)}")

        def terminate() -> list[str]:
            self._event("terminate")
            if self.terminate_error is not None:
                raise self.terminate_error
            return ["wf-1"]

        return cli.SlotSwitch(running=running, stop=stop, start=start, terminate=terminate)


@pytest.fixture
def fake_services(repo: Path, monkeypatch: pytest.MonkeyPatch) -> FakeServices:
    fake = FakeServices(repo)
    monkeypatch.setattr(cli, "SWITCH", fake.switch())
    return fake


@pytest.fixture(autouse=True)
def _in_repo(repo: Path, monkeypatch: pytest.MonkeyPatch, fake_services: FakeServices) -> None:
    monkeypatch.setattr(cli, "_root", lambda: repo)


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


def test_start_copies_problem_code_but_not_tests_and_sets_state(repo: Path) -> None:
    out = ex("start", "_smoke.1")
    assert out == {
        "step": "_smoke.1",
        "files": ["greeting.py"],
        "already_active": False,
        "restarted": ["workers"],
        "terminated": ["wf-1"],
        "skipped": [],
    }
    assert sorted(p.name for p in (repo / "playground").iterdir()) == ["greeting.py"]
    saved = json.loads((repo / ".ex" / "state.json").read_text())
    assert saved == {"active_step": "_smoke.1", "passed": []}


@pytest.mark.parametrize("command", ["start", "reset", "solution"])
def test_switching_code_stops_services_and_ends_runs_first(
    command: str, fake_services: FakeServices
) -> None:
    if command == "solution":
        ex("start", "_smoke.1")
        fake_services.events.clear()
    ex(command, "_smoke.1")
    before = "_smoke.1" if command == "solution" else None
    assert fake_services.events == [
        ("stop workers", before),
        ("terminate", before),
        ("start workers", "_smoke.1"),
    ]


def test_a_failed_termination_leaves_the_step_unswitched(
    repo: Path, fake_services: FakeServices
) -> None:
    fake_services.terminate_error = RuntimeError("permission denied")
    out = ex("start", "_smoke.1", ok=False)
    assert out["error"] == "couldn't terminate the open workflow runs, so the step wasn't switched"
    assert out["detail"] == "RuntimeError: permission denied"
    assert state.read(repo).active_step is None
    assert not (repo / "playground").exists()
    assert fake_services.events[-1] == ("start workers", None)  # back up on the old code


@pytest.mark.parametrize("running", [[], ["api", "relay"]])
def test_switching_goes_ahead_when_temporal_is_not_running_and_no_workers_are(
    fake_services: FakeServices, running: list[str]
) -> None:
    fake_services.running = running
    fake_services.terminate_error = services.TemporalUnreachableError("Temporal isn't running")
    out = ex("start", "_smoke.1")
    assert out["terminated"] == []
    assert out["skipped"] == ["terminate: Temporal isn't running"]


def test_switching_is_refused_when_workers_run_but_temporal_is_unreachable(
    repo: Path, fake_services: FakeServices
) -> None:
    """The workers may hold open runs we can't see or end, and the new code would break them."""
    fake_services.terminate_error = services.TemporalUnreachableError("Temporal isn't running")
    out = ex("start", "_smoke.1", ok=False)
    assert out["error"] == (
        "the workers are running but Temporal is unreachable, so their open runs can't be "
        "terminated; start Temporal (`ex up`) or stop the workers, then switch again"
    )
    assert out["detail"] == "Temporal isn't running"
    assert state.read(repo).active_step is None
    assert fake_services.events[-1] == ("start workers", None)


def test_switching_outside_dev_skips_termination(fake_services: FakeServices) -> None:
    fake_services.terminate_error = services.TerminateSkippedError("AC_ENV is test, not dev")
    assert ex("start", "_smoke.1")["skipped"] == ["terminate: AC_ENV is test, not dev"]


def test_a_failed_stop_still_restarts_the_services(repo: Path, fake_services: FakeServices) -> None:
    fake_services.running = ["api", "workers"]
    fake_services.stop_error = ExError("docker compose stop api workers failed")
    out = ex("start", "_smoke.1", ok=False)
    assert out["error"] == "docker compose stop api workers failed"
    assert state.read(repo).active_step is None
    assert [name for name, _ in fake_services.events] == ["stop api workers", "start api workers"]


def test_switching_without_the_stack_restarts_nothing(
    fake_services: FakeServices, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_docker(root: Path) -> list[str]:
        raise ExError("docker compose ps failed")

    monkeypatch.setattr(cli.SWITCH, "running", no_docker)
    out = ex("start", "_smoke.1")
    assert out["restarted"] == []
    assert out["skipped"] == ["restart: docker compose ps failed"]
    assert [name for name, _ in fake_services.events] == ["terminate"]


def test_start_again_keeps_your_work(repo: Path) -> None:
    ex("start", "_smoke.1")
    (repo / "playground" / "greeting.py").write_text("mine")
    assert ex("start", "_smoke.1")["already_active"] is True
    assert (repo / "playground" / "greeting.py").read_text() == "mine"
    ex("reset", "_smoke.1")
    assert "NotImplementedError" in (repo / "playground" / "greeting.py").read_text()


@pytest.mark.parametrize("copy", ["problem", "solution"])
def test_start_another_step_clears_an_untouched_playground(repo: Path, copy: str) -> None:
    ex("start", "_smoke.1")
    if copy == "solution":
        ex("solution", "_smoke.1")
    ex("start", "00.1")
    assert list((repo / "playground").iterdir()) == []


def test_start_another_step_keeps_your_changes_unless_forced(repo: Path) -> None:
    ex("start", "_smoke.1")
    (repo / "playground" / "greeting.py").write_text("mine")

    out = ex("start", "00.1", ok=False)
    assert out["error"] == "playground/ has changes to _smoke.1 that `ex start 00.1` would discard"
    assert (repo / "playground" / "greeting.py").read_text() == "mine"
    assert state.read(repo).active_step == "_smoke.1"

    ex("start", "00.1", "--force")
    assert list((repo / "playground").iterdir()) == []
    assert state.read(repo).active_step == "00.1"


def test_an_extra_playground_file_counts_as_a_change(repo: Path) -> None:
    ex("start", "_smoke.1")
    (repo / "playground" / "notes.py").write_text("")
    ex("start", "00.1", ok=False)


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
    assert list(files) == ["greeting.py"]
    assert files["greeting.py"]["changed"] is True
    assert "+    return f'hello {name}'" in files["greeting.py"]["diff"]
    ex("solution", "_smoke.1")
    assert not any(f["changed"] for f in ex("diff", "_smoke.1")["files"])


def test_tests_run_from_the_problem_dir_not_the_playground(repo: Path) -> None:
    """A test file dropped in playground/ (or an edited copy) can't grade the step."""
    ex("start", "_smoke.1")
    (repo / "playground" / "test_greeting.py").write_text("def test_greet():\n    pass\n")
    out = ex("test", "_smoke.1", ok=False)
    (only,) = out["tests"]
    assert only["nodeid"].startswith("exercises/_smoke/01.problem.greeting/")
    assert only["outcome"] == "failed"


def test_playground_passes_with_the_solution_code(repo: Path) -> None:
    ex("start", "_smoke.1")
    ex("solution", "_smoke.1")
    assert ex("test", "_smoke.1")["passed"] is True


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


def test_gate_refuses_tests_in_the_solution_dir(repo: Path) -> None:
    problem_tests = repo / "exercises/_smoke/01.problem.greeting/test_greeting.py"
    (repo / "exercises/_smoke/01.solution.greeting/test_greeting.py").write_text(
        problem_tests.read_text()
    )
    out = ex("gate", ok=False)
    assert out["steps"][0]["reasons"] == [
        "exercises/_smoke/01.solution.greeting has test files (test_greeting.py); "
        "a step's tests live in its problem dir only"
    ]


def test_up_stops_before_compose_when_a_port_is_taken(monkeypatch: pytest.MonkeyPatch) -> None:
    composed: list[tuple[str, ...]] = []

    def preflight(root: Path, profiles: tuple[str, ...]) -> None:
        raise ExError("ports already in use", detail=[{"port": 6379, "process": "redis-server"}])

    def compose(root: Path, *args: str, **kwargs: object) -> str:
        composed.append(args)
        return ""

    monkeypatch.setattr(services, "preflight", preflight)
    monkeypatch.setattr(services, "compose", compose)
    out = ex("up", ok=False)
    assert out == {
        "error": "ports already in use",
        "detail": [{"port": 6379, "process": "redis-server"}],
    }
    assert composed == []


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
