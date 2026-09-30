import json
from pathlib import Path
from typing import Any, cast

import pytest
import yaml

from ac_core.slots import find_repo_root
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


def test_only_running_slot_services_are_stopped_and_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, ...]] = []

    def compose(root: Path, *args: str, **kwargs: object) -> str:
        calls.append(args)
        return "\n".join(json.dumps(r) for r in ROWS) if args[0] == "ps" else ""

    monkeypatch.setattr(services, "compose", compose)
    running = services.running_slot_services(Path("/repo"))
    assert running == ["api", "relay"]
    services.stop_services(Path("/repo"), running)
    services.start_services(Path("/repo"), running)
    assert calls[-2:] == [("stop", "api", "relay"), ("start", "api", "relay")]


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


CONFIG = {
    "services": {
        "redis": {"ports": [{"host_ip": "127.0.0.1", "target": 6379, "published": "6379"}]},
        "envoy": {"ports": [{"target": 8080, "published": "8080"}, {"target": 9901}]},
        "relay": {},
    }
}

LSOF = """p501
cOrbStack Helper
f10
n127.0.0.1:8080
p777
credis-server
f6
n*:6379
f7
n[::1]:6379
"""


def fake_compose_config(monkeypatch: pytest.MonkeyPatch) -> None:
    def compose(root: Path, *args: str, **kwargs: object) -> str:
        assert args == ("config", "--format", "json")
        return json.dumps(CONFIG)

    monkeypatch.setattr(services, "compose", compose)


def test_published_ports(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_compose_config(monkeypatch)
    assert services.published_ports(Path("/repo"), ("infra",)) == {6379: "redis", 8080: "envoy"}


def test_parse_lsof() -> None:
    assert services.parse_lsof(LSOF, {6379, 8080}) == [
        services.Listener(port=8080, process="OrbStack Helper", pid=501),
        services.Listener(port=6379, process="redis-server", pid=777),
    ]


def test_preflight_names_the_process_holding_a_port(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_compose_config(monkeypatch)

    def listeners(ports: set[int]) -> list[services.Listener]:
        return services.parse_lsof(LSOF, ports)

    with pytest.raises(ExError) as caught:
        services.preflight(Path("/repo"), ("infra",), listeners=listeners)
    assert caught.value.message == "ports already in use: 6379 (redis-server)"
    assert caught.value.detail == [
        {"port": 6379, "service": "redis", "process": "redis-server", "pid": 777}
    ]


def test_preflight_passes_when_only_docker_listens(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_compose_config(monkeypatch)

    def listeners(ports: set[int]) -> list[services.Listener]:
        return [
            services.Listener(port=8080, process="OrbStack Helper", pid=1),
            services.Listener(port=6379, process="com.docker.backend", pid=2),
        ]

    services.preflight(Path("/repo"), ("infra",), listeners=listeners)


def test_compose_publishes_only_on_loopback_and_never_the_api() -> None:
    """The api trusts x-jwt-payload, so only Envoy may reach it; nothing else leaves the host."""
    compose = yaml.safe_load((find_repo_root() / services.COMPOSE_FILE).read_text())
    published = {
        name: cast(list[str], service.get("ports", []))
        for name, service in cast(dict[str, dict[str, Any]], compose["services"]).items()
    }
    assert published["api"] == []
    assert [
        (name, port)
        for name, ports in published.items()
        for port in ports
        if not port.startswith("127.0.0.1:")
    ] == []
