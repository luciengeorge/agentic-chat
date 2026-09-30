import asyncio
import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Annotated, NoReturn, cast

import typer

from ac_core.slots import SlotError, find_repo_root
from ac_ex import catalog, gate, services, smoke, state, testing, workspace
from ac_ex.catalog import Step
from ac_ex.errors import ExError

app = typer.Typer(
    help="Workshop step CLI. Every command takes --json.",
    no_args_is_help=True,
    add_completion=False,
    pretty_exceptions_enable=False,
)

JsonFlag = Annotated[bool, typer.Option("--json", help="Print machine-readable JSON.")]
StepArg = Annotated[str, typer.Argument(help="Step id, like 09.2.")]
WEB_HINT = [
    "pnpm --filter web dev        # http://localhost:3000",
    "pnpm --filter workshop dev   # http://localhost:3100",
]


class TestTarget(StrEnum):
    __test__ = False

    playground = "playground"
    problem = "problem"
    solution = "solution"

    @property
    def value(self) -> testing.Target:
        return cast(testing.Target, str(self))


def _root() -> Path:
    try:
        return find_repo_root()
    except SlotError as exc:
        raise ExError(str(exc)) from exc


def _print_json(payload: object) -> None:
    sys.stdout.write(json.dumps(payload, indent=2) + "\n")


def _fail(as_json: bool, message: str, detail: object = None) -> NoReturn:
    if as_json:
        _print_json({"error": message, "detail": detail})
    else:
        typer.echo(f"error: {message}", err=True)
        if detail is not None:
            typer.echo(str(detail), err=True)
    raise typer.Exit(1)


def _run(as_json: bool, body: Callable[[], tuple[object, str, bool]]) -> None:
    """Runs a command body that returns (json payload, human text, ok)."""
    try:
        payload, text, ok = body()
    except (ExError, SlotError) as exc:
        detail = exc.detail if isinstance(exc, ExError) else None
        _fail(as_json, exc.message if isinstance(exc, ExError) else str(exc), detail)
    if as_json:
        _print_json(payload)
    elif text:
        typer.echo(text)
    if not ok:
        raise typer.Exit(1)


def _step_json(step: Step, root: Path, current: state.State) -> dict[str, object]:
    status = (
        "active"
        if step.id == current.active_step
        else "passed"
        if step.id in current.passed
        else "not_started"
    )
    return {
        "id": step.id,
        "slug": step.slug,
        "title": step.title,
        "type": step.type,
        "problem_dir": str(step.problem_dir.relative_to(root)),
        "solution_dir": str(step.solution_dir.relative_to(root)),
        "status": status,
    }


@app.command()
def up(
    as_json: JsonFlag = False,
    profile: Annotated[
        list[str] | None, typer.Option(help="Compose profile (infra, apps). Default: both.")
    ] = None,
) -> None:
    """Start the Compose stack and wait until it's healthy."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        profiles = tuple(profile or services.PROFILES)
        services.preflight(root, profiles)
        services.compose(root, "up", "--detach", "--wait", profiles=profiles, capture=as_json)
        statuses = services.status(root)
        text = "\n".join(
            ["stack is up. The web apps run on the host:", *(f"  {h}" for h in WEB_HINT)]
        )
        return {"services": [s.to_json() for s in statuses], "next": WEB_HINT}, text, True

    _run(as_json, body)


@app.command()
def down(
    as_json: JsonFlag = False,
    volumes: Annotated[bool, typer.Option(help="Also delete the data volumes.")] = False,
) -> None:
    """Stop the Compose stack."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        services.compose(root, "down", *(["--volumes"] if volumes else []), capture=as_json)
        return {"stopped": True, "volumes_removed": volumes}, "stack is down", True

    _run(as_json, body)


@app.command("list")
def list_steps(
    as_json: JsonFlag = False,
    show_all: Annotated[bool, typer.Option("--all", help="Include hidden steps.")] = False,
) -> None:
    """List sections and steps with your progress."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        current = state.read(root)
        sections: list[dict[str, object]] = []
        lines: list[str] = []
        for section in catalog.load(root):
            steps = [s for s in section.steps if show_all or not s.hidden]
            if (section.hidden and not show_all) or not steps:
                continue
            step_rows = [_step_json(s, root, current) for s in steps]
            sections.append(
                {
                    "id": section.id,
                    "slug": section.slug,
                    "title": section.title,
                    "hidden": section.hidden,
                    "steps": step_rows,
                }
            )
            lines.append(f"{section.id} {section.title}")
            lines.extend(
                f"  {row['id']:<8} {row['title']}  [{row['type']}, {row['status']}]"
                for row in step_rows
            )
        return {"sections": sections}, "\n".join(lines), True

    _run(as_json, body)


@dataclass
class AfterSwitch:
    restarted: list[str] = field(default_factory=list[str])
    terminated: list[str] = field(default_factory=list[str])
    skipped: list[str] = field(default_factory=list[str])

    def to_json(self) -> dict[str, object]:
        return {"restarted": self.restarted, "terminated": self.terminated, "skipped": self.skipped}


def _terminate_open_runs() -> list[str]:
    from ac_core.settings import get_settings

    settings = get_settings()
    if settings.env != "dev":
        raise services.TerminateSkippedError(f"AC_ENV is {settings.env}, not dev")
    return asyncio.run(
        services.terminate_open_workflows(
            settings.temporal_address, settings.temporal_namespace, reason="ex switched steps"
        )
    )


@dataclass
class SlotSwitch:
    """Swaps the slotted code with nothing running on it (PLAN.md, "Slots vs Temporal").

    Stop the slot services, terminate the open runs (whose replay the new code would break),
    swap the files, then start the services again. A failed termination aborts the switch
    and starts the services on the old code.
    """

    running: Callable[[Path], list[str]] = services.running_slot_services
    stop: Callable[[Path, list[str]], None] = services.stop_services
    start: Callable[[Path, list[str]], None] = services.start_services
    terminate: Callable[[], list[str]] = _terminate_open_runs

    def run(self, root: Path, swap: Callable[[], list[str]]) -> tuple[list[str], AfterSwitch]:
        after = AfterSwitch()
        try:
            running = self.running(root)
        except ExError as exc:  # no Docker or no stack: nothing to restart
            running = []
            after.skipped.append(f"restart: {exc.message}")
        if running:
            self.stop(root, running)
        try:
            try:
                after.terminated = self.terminate()
            except services.TerminateSkippedError as exc:
                after.skipped.append(f"terminate: {exc}")
            except Exception as exc:
                raise ExError(
                    "couldn't terminate the open workflow runs, so the step wasn't switched",
                    detail=f"{type(exc).__name__}: {exc}",
                ) from exc
            files = swap()
        finally:
            if running:
                self.start(root, running)
        after.restarted = running
        return files, after


SWITCH = SlotSwitch()


def _refuse_to_discard(root: Path, step: Step, current: state.State) -> None:
    if current.active_step in (None, step.id):
        return
    try:
        active = catalog.find(root, current.active_step)
    except ExError:  # the active step is gone from exercises/; nothing to compare against
        return
    if workspace.has_changes(root, active):
        raise ExError(
            f"playground/ has changes to {active.id} that `ex start {step.id}` would discard",
            detail=f"`ex diff {active.id}` shows them; `ex start {step.id} --force` discards them",
        )


def _switch(step: Step, root: Path, *, restart: bool, force: bool) -> tuple[object, str, bool]:
    current = state.read(root)
    if current.active_step == step.id and not restart:
        text = f"{step.id} is already active; `ex reset {step.id}` starts it over"
        return {"step": step.id, "files": [], "already_active": True}, text, True
    if not force:
        _refuse_to_discard(root, step, current)
    files, after = SWITCH.run(root, lambda: workspace.activate(root, step))
    lines = [f"started {step.id} {step.title}", *(f"  playground/{f}" for f in files)]
    if after.restarted:
        lines.append(f"restarted {', '.join(after.restarted)}")
    payload = {"step": step.id, "files": files, "already_active": False, **after.to_json()}
    return payload, "\n".join(lines), True


@app.command()
def start(
    step_id: StepArg,
    as_json: JsonFlag = False,
    force: Annotated[
        bool, typer.Option("--force", help="Discard playground changes to the active step.")
    ] = False,
) -> None:
    """Copy a step's problem files into playground/ and make it active."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        return _switch(catalog.find(root, step_id), root, restart=False, force=force)

    _run(as_json, body)


@app.command()
def reset(step_id: StepArg, as_json: JsonFlag = False) -> None:
    """Throw away your playground changes and start the step over."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        return _switch(catalog.find(root, step_id), root, restart=True, force=True)

    _run(as_json, body)


@app.command("test")
def run_tests(
    step_id: StepArg,
    as_json: JsonFlag = False,
    target: Annotated[
        TestTarget, typer.Option(help="Which copy to grade.")
    ] = TestTarget.playground,
) -> None:
    """Run a step's tests."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        step = catalog.find(root, step_id)
        if step.type != "graded":
            raise ExError(f"{step.id} is a {step.type} step; it has no tests")
        if target is TestTarget.playground:
            workspace.require_active(root, step)
        run = testing.run(root, step, target.value, capture=as_json)
        if run.passed and target is TestTarget.playground:
            workspace.mark_passed(root, step)
        return run.to_json(), f"{step.id}: {'passed' if run.passed else 'failed'}", run.passed

    _run(as_json, body)


@app.command()
def diff(step_id: StepArg, as_json: JsonFlag = False) -> None:
    """Show how your playground differs from the solution."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        step = catalog.find(root, step_id)
        workspace.require_active(root, step)
        diffs = workspace.diff(root, step)
        text = "".join(d.diff for d in diffs) or "no differences"
        return {"step": step.id, "files": [d.to_json() for d in diffs]}, text, True

    _run(as_json, body)


@app.command()
def solution(step_id: StepArg, as_json: JsonFlag = False) -> None:
    """Replace your playground files with the solution."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        step = catalog.find(root, step_id)
        workspace.require_active(root, step)
        files, after = SWITCH.run(
            root, lambda: workspace.fill_playground(root, step.solution_dir, step)
        )
        text = "\n".join([f"copied the {step.id} solution", *(f"  playground/{f}" for f in files)])
        return {"step": step.id, "files": files, **after.to_json()}, text, True

    _run(as_json, body)


@app.command()
def record(as_json: JsonFlag = False) -> None:
    """Re-record the model cassettes against the real API (needs OPENAI_API_KEY)."""

    def body() -> tuple[object, str, bool]:
        root = _root()
        if not os.environ.get("OPENAI_API_KEY"):
            raise ExError("OPENAI_API_KEY is not set; recording calls the real API")
        env = {**os.environ, "AC_CASSETTE_MODE": "record"}
        command = [sys.executable, "-m", "pytest", "-m", "cassette", "-p", "no:cacheprovider"]
        result = subprocess.run(command, cwd=root, env=env, capture_output=as_json, text=True)
        # pytest exits 5 when no test is marked `cassette` yet.
        ok = result.returncode in (0, 5)
        payload = {"recorded": ok, "exit_code": result.returncode}
        return payload, "cassettes recorded" if ok else "recording failed", ok

    _run(as_json, body)


@app.command()
def fixtures(as_json: JsonFlag = False) -> None:
    """Build the corpus and directory fixtures."""
    _fail(as_json, "ex fixtures is not implemented until M0b", detail={"milestone": "M0b"})


@app.command("gate")
def gate_command(as_json: JsonFlag = False) -> None:
    """Check every graded step: the problem must fail and the solution must pass."""

    def body() -> tuple[object, str, bool]:
        results = gate.run(_root())
        ok = all(r.passed for r in results)
        lines = [
            f"{'ok  ' if r.passed else 'FAIL'} {r.step}"
            + ("" if r.passed else f"  ({'; '.join(r.reasons)})")
            for r in results
        ]
        payload = {"passed": ok, "steps": [r.to_json() for r in results]}
        return payload, "\n".join(lines) or "no graded steps", ok

    _run(as_json, body)


@app.command("smoke")
def smoke_command(as_json: JsonFlag = False) -> None:
    """Check the running stack end to end."""

    def body() -> tuple[object, str, bool]:
        results = asyncio.run(smoke.Smoke(root=_root()).run())
        ok = all(r.passed for r in results)
        lines = [
            f"{'ok  ' if r.passed else 'FAIL'} {r.name}" + (f"  {r.detail}" if r.detail else "")
            for r in results
        ]
        payload = {"passed": ok, "checks": [r.to_json() for r in results]}
        return payload, "\n".join(lines), ok

    _run(as_json, body)


def main() -> None:
    app()
