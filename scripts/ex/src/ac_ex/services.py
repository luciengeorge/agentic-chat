import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from ac_ex.errors import ExError

COMPOSE_FILE = Path("infra/compose.yaml")
PROFILES = ("infra", "apps")
SLOT_SERVICES = ("api", "workers", "relay")


@dataclass(frozen=True)
class ServiceStatus:
    name: str
    state: str
    health: str

    @property
    def healthy(self) -> bool:
        return self.state == "running" and self.health in ("", "healthy")

    def to_json(self) -> dict[str, object]:
        return {"name": self.name, "state": self.state, "health": self.health or None}


def compose_command(root: Path, *args: str, profiles: tuple[str, ...] = PROFILES) -> list[str]:
    if shutil.which("docker") is None:
        raise ExError("docker is not on PATH")
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
        )
        for row in rows
    ]


def status(root: Path) -> list[ServiceStatus]:
    return parse_ps(compose(root, "ps", "--all", "--format", "json"))


def restart_slot_services(root: Path) -> list[str]:
    """Restart api, workers and relay if they're running, so they re-resolve slots."""
    running = [s.name for s in status(root) if s.state == "running" and s.name in SLOT_SERVICES]
    if running:
        compose(root, "restart", *running)
    return running


async def terminate_open_workflows(address: str, namespace: str, reason: str) -> list[str]:
    from temporalio.client import Client

    client = await Client.connect(address, namespace=namespace)
    terminated: list[str] = []
    async for execution in client.list_workflows('ExecutionStatus="Running"'):
        await client.get_workflow_handle(execution.id, run_id=execution.run_id).terminate(
            reason=reason
        )
        terminated.append(execution.id)
    return terminated
