"""Every app image's prod stage runs as prod. Settings default to `AC_ENV=dev`, which turns on
dev-only surfaces such as fake-workspace's control API, so a prod image must never fall back."""

import shlex
from pathlib import Path

import pytest

from ac_core.slots import find_repo_root

DOCKERFILES = sorted((find_repo_root() / "apps").glob("*/Dockerfile"))


def stages(dockerfile: str) -> list[tuple[str | None, list[str]]]:
    """Every stage, in order, as (its name or None, its instructions), continuation lines
    joined and comments dropped."""
    joined = dockerfile.replace("\\\n", " ")
    found: list[tuple[str | None, list[str]]] = []
    for line in joined.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        words = line.split()
        if words[0].upper() == "FROM":
            named = len(words) >= 4 and words[-2].upper() == "AS"
            found.append((words[-1] if named else None, []))
        if found:
            found[-1][1].append(line)
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
    found = stages(dockerfile.read_text(encoding="utf-8"))
    prod = [instructions for name, instructions in found if name == "prod"]
    assert len(prod) == 1
    assert env(prod[0]).get("AC_ENV") == "prod"
    # The last stage is what a build without --target makes, so it must be prod itself.
    assert found[-1][0] == "prod"


def test_the_parser_reads_both_env_forms() -> None:
    dockerfile = (
        "FROM a AS dev\nENV AC_ENV=dev\n"
        "FROM b AS prod\n# ENV AC_ENV=dev\n"
        "ENV PATH=/x:$PATH \\\n    AC_ENV=prod\nENV MODE fast lane\n"
    )
    parsed = dict(stages(dockerfile))
    assert env(parsed["dev"]) == {"AC_ENV": "dev"}
    assert env(parsed["prod"]) == {"PATH": "/x:$PATH", "AC_ENV": "prod", "MODE": "fast lane"}


def test_the_parser_keeps_unnamed_stages() -> None:
    found = stages("FROM a AS prod\nENV AC_ENV=prod\nFROM prod\nENV AC_ENV=dev\n")
    assert [name for name, _ in found] == ["prod", None]
    assert env(found[-1][1]) == {"AC_ENV": "dev"}
