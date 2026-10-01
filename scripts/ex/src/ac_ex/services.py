import asyncio
import json
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ac_ex.errors import ExError

COMPOSE_FILE = Path("infra/compose.yaml")
PROFILES = ("infra", "apps")
SLOT_SERVICES = ("api", "workers", "relay")
# The processes that hold a published port on the host for a container.
DOCKER_LISTENERS = ("orbstack", "com.docker", "docker", "vpnkit")
TEMPORAL_CONNECT_TIMEOUT_S = 5.0
TERMINATE_TIMEOUT_S = 30.0


class TerminateSkippedError(Exception):
    """Termination didn't happen: Temporal isn't running, or this isn't dev."""


class TemporalUnreachableError(TerminateSkippedError):
    pass


class DockerMissingError(ExError):
    """`docker` isn't on PATH, so no Compose command can run."""


@dataclass(frozen=True)
class ServiceStatus:
    name: str
    state: str
    health: str
    id: str = ""  # the container's

    @property
    def healthy(self) -> bool:
        return self.state == "running" and self.health in ("", "healthy")

    def to_json(self) -> dict[str, object]:
        return {"name": self.name, "state": self.state, "health": self.health or None}


def compose_command(root: Path, *args: str, profiles: tuple[str, ...] = PROFILES) -> list[str]:
    if shutil.which("docker") is None:
        raise DockerMissingError("docker is not on PATH")
    if not (root / COMPOSE_FILE).is_file():
        raise ExError(f"{COMPOSE_FILE} is missing")
    flags = [flag for profile in profiles for flag in ("--profile", profile)]
    return ["docker", "compose", "-f", str(root / COMPOSE_FILE), *flags, *args]


def compose(
    root: Path, *args: str, profiles: tuple[str, ...] = PROFILES, capture: bool = True
) -> str:
    command = compose_command(root, *args, profiles=profiles)
    result = subprocess.run(command, cwd=root, capture_output=capture, text=True)
    if result.returncode != 0:
        raise ExError(
            f"docker compose {' '.join(args)} failed", detail=result.stderr if capture else None
        )
    return result.stdout if capture else ""


def parse_ps(output: str) -> list[ServiceStatus]:
    """`docker compose ps --format json`: one object per line (older Compose: one array)."""
    text = output.strip()
    if text.startswith("["):
        rows = cast(list[dict[str, object]], json.loads(text))
    else:
        rows = [cast(dict[str, object], json.loads(line)) for line in text.splitlines() if line]
    return [
        ServiceStatus(
            name=str(row.get("Service", "")),
            state=str(row.get("State", "")),
            health=str(row.get("Health") or ""),
            id=str(row.get("ID") or ""),
        )
        for row in rows
    ]


def status(root: Path) -> list[ServiceStatus]:
    return parse_ps(compose(root, "ps", "--all", "--format", "json"))


def running_slot_services(root: Path) -> list[str]:
    """The slot services (api, workers, relay) that are running now."""
    return [s.name for s in status(root) if s.state == "running" and s.name in SLOT_SERVICES]


def stop_services(root: Path, names: list[str]) -> None:
    compose(root, "stop", *names)


def start_services(root: Path, names: list[str]) -> None:
    compose(root, "start", *names)


def recreate_service(root: Path, name: str) -> None:
    """A new container for `name`, its dependencies left alone; returns once it's healthy."""
    compose(root, "up", "--detach", "--wait", "--force-recreate", "--no-deps", name)


def remove_service(root: Path, name: str) -> None:
    compose(root, "rm", "--force", "--stop", name)


async def terminate_open_workflows(address: str, namespace: str, reason: str) -> list[str]:
    """Terminate every running workflow in the namespace. Raises TemporalUnreachableError if
    Temporal isn't there to connect to; any failure after connecting propagates."""
    from temporalio.client import Client

    try:
        client = await asyncio.wait_for(
            Client.connect(address, namespace=namespace), TEMPORAL_CONNECT_TIMEOUT_S
        )
    except Exception as exc:  # whatever the reason, nothing is listening there
        raise TemporalUnreachableError(
            f"Temporal isn't running at {address} ({type(exc).__name__})"
        ) from exc
    terminated: list[str] = []
    async with asyncio.timeout(TERMINATE_TIMEOUT_S):
        async for execution in client.list_workflows('ExecutionStatus="Running"'):
            await client.get_workflow_handle(execution.id, run_id=execution.run_id).terminate(
                reason=reason
            )
            terminated.append(execution.id)
    return terminated


@dataclass(frozen=True)
class Listener:
    port: int
    process: str
    pid: int


def published_ports(root: Path, profiles: tuple[str, ...]) -> dict[int, str]:
    """Host port -> the Compose service that publishes it."""
    config = cast(
        dict[str, Any], json.loads(compose(root, "config", "--format", "json", profiles=profiles))
    )
    ports: dict[int, str] = {}
    for name, service in cast(dict[str, dict[str, Any]], config["services"]).items():
        for port in cast(list[dict[str, object]], service.get("ports") or []):
            if published := port.get("published"):
                ports[int(str(published))] = name
    return ports


def parse_lsof(output: str, ports: set[int]) -> list[Listener]:
    """`lsof -F pcn` output: `p<pid>` and `c<command>` per process, `n<addr>:<port>` per socket."""
    found: list[Listener] = []
    pid, process = 0, ""
    for line in output.splitlines():
        field, value = line[:1], line[1:]
        if field == "p":
            pid = int(value)
        elif field == "c":
            process = value
        elif field == "n":
            port = value.rpartition(":")[2]
            listener = (
                Listener(port=int(port), process=process, pid=pid) if port.isdigit() else None
            )
            if listener and listener.port in ports and listener not in found:
                found.append(listener)
    return found


def port_listeners(ports: set[int]) -> list[Listener]:
    """Who is listening on these TCP ports. Empty when lsof isn't installed."""
    if not ports or shutil.which("lsof") is None:
        return []
    spec = ",".join(str(p) for p in sorted(ports))
    command = ["lsof", "-nP", "+c", "0", "-sTCP:LISTEN", "-F", "pcn", f"-iTCP:{spec}"]
    # lsof exits 1 when nothing matches.
    result = subprocess.run(command, capture_output=True, text=True)
    return parse_lsof(result.stdout, ports)


def preflight(
    root: Path,
    profiles: tuple[str, ...],
    *,
    listeners: Callable[[set[int]], list[Listener]] = port_listeners,
) -> None:
    """Fail before `compose up` if something other than Docker holds a port we publish.

    Docker would fail too, but later and less clearly; a host process on a shared port
    (a brew Redis on 6379, say) can also answer in the container's place.
    """
    ports = published_ports(root, profiles)
    clashes = [
        listener
        for listener in listeners(set(ports))
        if not listener.process.lower().startswith(DOCKER_LISTENERS)
    ]
    if clashes:
        summary = ", ".join(f"{c.port} ({c.process})" for c in clashes)
        raise ExError(
            f"ports already in use: {summary}",
            detail=[
                {"port": c.port, "service": ports[c.port], "process": c.process, "pid": c.pid}
                for c in clashes
            ],
        )
