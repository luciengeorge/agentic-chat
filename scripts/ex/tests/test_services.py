import json
from pathlib import Path

import pytest

from ac_ex import services
from ac_ex.errors import ExError

ROWS = [
    {"Service": "api", "State": "running", "Health": "healthy"},
    {"Service": "relay", "State": "running", "Health": ""},
    {"Service": "keycloak", "State": "running", "Health": "starting"},
    {"Service": "redis", "State": "exited", "Health": ""},
]


@pytest.mark.parametrize(
    "output",
    ["\n".join(json.dumps(r) for r in ROWS) + "\n", json.dumps(ROWS), ""],
    ids=["lines", "array", "empty"],
)
def test_parse_ps(output: str) -> None:
    parsed = services.parse_ps(output)
    if not output:
        assert parsed == []
        return
    assert [(s.name, s.healthy) for s in parsed] == [
        ("api", True),
        ("relay", True),
        ("keycloak", False),
        ("redis", False),
    ]
    assert parsed[1].to_json() == {"name": "relay", "state": "running", "health": None}


def test_restart_only_running_slot_services(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, ...]] = []

    def compose(root: Path, *args: str, **kwargs: object) -> str:
        calls.append(args)
        return "\n".join(json.dumps(r) for r in ROWS) if args[0] == "ps" else ""

    monkeypatch.setattr(services, "compose", compose)
    assert services.restart_slot_services(Path("/repo")) == ["api", "relay"]
    assert calls[-1] == ("restart", "api", "relay")


def test_compose_needs_the_compose_file(tmp_path: Path) -> None:
    with pytest.raises(ExError, match=r"infra/compose\.yaml is missing|docker is not on PATH"):
        services.compose_command(tmp_path, "ps")


def test_compose_command_passes_profiles(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "infra").mkdir()
    (tmp_path / "infra" / "compose.yaml").write_text("services: {}\n")

    def which(name: str) -> str:
        return f"/bin/{name}"

    monkeypatch.setattr(services.shutil, "which", which)
    assert services.compose_command(tmp_path, "up", profiles=("infra",)) == [
        "docker",
        "compose",
        "-f",
        str(tmp_path / "infra" / "compose.yaml"),
        "--profile",
        "infra",
        "up",
    ]
