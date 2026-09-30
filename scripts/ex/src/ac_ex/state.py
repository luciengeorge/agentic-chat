import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from ac_core.slots import STATE_FILE


@dataclass
class State:
    active_step: str | None = None
    passed: list[str] = field(default_factory=list[str])


def read(root: Path) -> State:
    path = root / STATE_FILE
    if not path.is_file():
        return State()
    data = cast(dict[str, object], json.loads(path.read_text(encoding="utf-8")))
    active = data.get("active_step")
    passed = data.get("passed")
    return State(
        active_step=active if isinstance(active, str) else None,
        passed=[p for p in cast(list[object], passed) if isinstance(p, str)]
        if isinstance(passed, list)
        else [],
    )


def write(root: Path, state: State) -> None:
    path = root / STATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"active_step": state.active_step, "passed": sorted(set(state.passed))}
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
