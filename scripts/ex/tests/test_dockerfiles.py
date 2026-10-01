"""Every app image's prod stage runs as prod. Settings default to `AC_ENV=dev`, which turns on
dev-only surfaces such as fake-workspace's control API, so a prod image must never fall back."""

import shlex
from pathlib import Path

import pytest

from ac_core.slots import find_repo_root

DOCKERFILES = sorted((find_repo_root() / "apps").glob("*/Dockerfile"))


def stages(dockerfile: str) -> dict[str, list[str]]:
    """Each named stage's instructions, continuation lines joined and comments dropped."""
    joined = dockerfile.replace("\\\n", " ")
    found: dict[str, list[str]] = {}
    current: list[str] = []
    for line in joined.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        words = line.split()
        if words[0].upper() == "FROM":
            current = []
            if len(words) >= 4 and words[-2].upper() == "AS":
                found[words[-1]] = current
        current.append(line)
    return found


def env(instructions: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for instruction in instructions:
        keyword, _, rest = instruction.partition(" ")
        if keyword.upper() != "ENV":
            continue
        words = shlex.split(rest)
        if "=" not in words[0]:  # the legacy `ENV key value` form
            values[words[0]] = " ".join(words[1:])
            continue
        values |= dict(word.split("=", 1) for word in words)
    return values


def test_every_app_has_a_dockerfile() -> None:
    names = {path.parent.name for path in DOCKERFILES}
    assert {"api", "workers", "relay", "reranker", "fake_workspace"} <= names


@pytest.mark.parametrize("dockerfile", DOCKERFILES, ids=lambda p: p.parent.name)
def test_the_prod_stage_sets_ac_env_prod(dockerfile: Path) -> None:
    named = stages(dockerfile.read_text(encoding="utf-8"))
    assert env(named["prod"]).get("AC_ENV") == "prod"
    # The last stage is what a build without --target makes, so that's prod too.
    assert list(named)[-1] == "prod"


def test_the_parser_reads_both_env_forms() -> None:
    dockerfile = (
        "FROM a AS dev\nENV AC_ENV=dev\n"
        "FROM b AS prod\n# ENV AC_ENV=dev\n"
        "ENV PATH=/x:$PATH \\\n    AC_ENV=prod\nENV MODE fast lane\n"
    )
    parsed = stages(dockerfile)
    assert env(parsed["dev"]) == {"AC_ENV": "dev"}
    assert env(parsed["prod"]) == {"PATH": "/x:$PATH", "AC_ENV": "prod", "MODE": "fast lane"}
