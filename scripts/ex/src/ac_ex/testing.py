import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from ac_ex.catalog import Step
from ac_ex.errors import ExError

Target = Literal["playground", "problem", "solution"]


@dataclass(frozen=True)
class StepRun:
    step: str
    target: Target
    passed: bool
    exit_code: int
    tests: list[dict[str, object]]

    def to_json(self) -> dict[str, object]:
        return {
            "step": self.step,
            "target": self.target,
            "passed": self.passed,
            "tests": self.tests,
        }


def target_dir(root: Path, step: Step, target: Target) -> Path:
    match target:
        case "playground":
            return root / "playground"
        case "problem":
            return step.problem_dir
        case "solution":
            return step.solution_dir


def run(root: Path, step: Step, target: Target, *, capture: bool) -> StepRun:
    """Run a step's tests with its slots pointed at `target`, in a fresh interpreter."""
    directory = target_dir(root, step, target)
    if not any(directory.glob("test_*.py")):
        raise ExError(f"no test_*.py in {directory.relative_to(root)}")
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "report.json"
        env = {
            **os.environ,
            "AC_ENV": "test",
            "AC_ACTIVE_STEP": step.id,
            "AC_SLOT_ROOT": str(directory),
            "AC_EX_REPORT": str(report),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        command = [
            sys.executable,
            "-m",
            "pytest",
            str(directory),
            "--rootdir",
            str(root),
            "-p",
            "ac_ex.pytest_report",
            "-p",
            "no:cacheprovider",
            "-q",
        ]
        result = subprocess.run(command, cwd=root, env=env, capture_output=capture, text=True)
        if not report.is_file():
            raise ExError(
                "pytest did not produce a report",
                detail=(result.stdout or "") + (result.stderr or "") if capture else None,
            )
        tests = cast(list[dict[str, object]], json.loads(report.read_text(encoding="utf-8")))
    passed = result.returncode == 0 and any(t["outcome"] == "passed" for t in tests)
    return StepRun(
        step=step.id, target=target, passed=passed, exit_code=result.returncode, tests=tests
    )
