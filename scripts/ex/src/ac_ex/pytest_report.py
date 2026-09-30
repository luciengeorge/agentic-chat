"""pytest plugin: writes one result per test to the JSON file named by AC_EX_REPORT."""

import json
import os
from pathlib import Path

import pytest

_results: dict[str, dict[str, object]] = {}


def _message(report: pytest.TestReport | pytest.CollectReport) -> str | None:
    if report.passed:
        return None
    crash = getattr(report.longrepr, "reprcrash", None)
    message = getattr(crash, "message", None)
    return message if isinstance(message, str) else report.longreprtext or None


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    entry = _results.setdefault(
        report.nodeid,
        {"nodeid": report.nodeid, "outcome": "passed", "duration_s": 0.0, "message": None},
    )
    duration = entry["duration_s"]
    assert isinstance(duration, float)
    entry["duration_s"] = round(duration + report.duration, 4)
    if report.when == "call":
        entry["outcome"] = report.outcome
        entry["message"] = _message(report)
    elif report.failed:
        entry["outcome"] = "error"
        entry["message"] = _message(report)
    elif report.skipped:
        entry["outcome"] = "skipped"


def pytest_collectreport(report: pytest.CollectReport) -> None:
    if report.failed:
        _results[report.nodeid] = {
            "nodeid": report.nodeid,
            "outcome": "error",
            "duration_s": 0.0,
            "message": _message(report),
        }


def pytest_sessionfinish(session: pytest.Session) -> None:
    if target := os.environ.get("AC_EX_REPORT"):
        Path(target).write_text(json.dumps(list(_results.values())), encoding="utf-8")
