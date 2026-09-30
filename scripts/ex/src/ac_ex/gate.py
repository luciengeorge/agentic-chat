from dataclasses import dataclass
from pathlib import Path

from ac_ex import catalog, testing
from ac_ex.catalog import Step


@dataclass(frozen=True)
class GateResult:
    step: str
    passed: bool
    reasons: list[str]
    problem: testing.StepRun | None
    solution: testing.StepRun | None

    def to_json(self) -> dict[str, object]:
        return {
            "step": self.step,
            "passed": self.passed,
            "reasons": self.reasons,
            "problem": self.problem.to_json() if self.problem else None,
            "solution": self.solution.to_json() if self.solution else None,
        }


def check_step(root: Path, step: Step) -> GateResult:
    """The problem's tests must fail (not error) and the solution's must pass."""
    reasons: list[str] = []
    if not step.slots:
        reasons.append("graded step declares no slots, so its tests can't grade anything")
    for directory in (step.problem_dir, step.solution_dir):
        for file in step.slots.values():
            if not (directory / file).is_file():
                reasons.append(f"{directory.relative_to(root)} is missing slot file {file}")
    if reasons:
        return GateResult(step.id, False, reasons, None, None)
    problem = testing.run(root, step, "problem", capture=True)
    solution = testing.run(root, step, "solution", capture=True)
    if problem.passed:
        reasons.append("problem tests pass; they grade nothing")
    elif not any(t["outcome"] == "failed" for t in problem.tests):
        reasons.append("problem tests error instead of failing")
    if any(t["outcome"] == "error" for t in problem.tests):
        reasons.append("problem tests have errors")
    if not solution.passed:
        reasons.append("solution tests don't pass")
    return GateResult(step.id, not reasons, reasons, problem, solution)


def run(root: Path) -> list[GateResult]:
    return [
        check_step(root, step)
        for section in catalog.load(root)
        for step in section.steps
        if step.type == "graded"
    ]
