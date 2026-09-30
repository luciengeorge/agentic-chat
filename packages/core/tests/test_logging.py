import json
import logging
from collections.abc import Iterator

import pytest
import structlog

from ac_core.logging import configure_logging


@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    yield
    root.handlers, root.level = handlers, level
    structlog.reset_defaults()


def test_structlog_and_stdlib_both_log_json(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("api")
    structlog.get_logger("t").info("hello", user="u1")
    logging.getLogger("uvicorn.error").warning("from stdlib")
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert lines[0] | {"timestamp": None} == {
        "event": "hello",
        "user": "u1",
        "level": "info",
        "logger": "t",
        "service": "api",
        "timestamp": None,
    }
    assert lines[1]["event"] == "from stdlib"
    assert lines[1]["service"] == "api"
    assert lines[1]["level"] == "warning"
