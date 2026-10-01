"""The fictional world in `fixtures/world.yaml`: tenants, their directory and their folders.

Ids are never stored; they derive from the world (`uuid5` of `<tenant>:<kind>:<name>`), so
Keycloak, the corpus manifest and fake-workspace agree without a lookup table.
"""

from collections.abc import Hashable, Iterable, Sequence
from datetime import date
from pathlib import Path
from typing import Annotated, Any, Literal, Self
from uuid import UUID, uuid5

import yaml
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, ValidationError, model_validator

from ac_core.slots import find_repo_root

Role = Literal["read", "write"]
RealmRole = Literal["employee", "admin"]

SLUG = r"^[a-z0-9]+(-[a-z0-9]+)*$"
USERNAME = r"^[a-z0-9]+([._-][a-z0-9]+)*$"

_ROLE_RANK: dict[Role, int] = {"read": 0, "write": 1}


class WorldError(Exception):
    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = tuple(problems)
        super().__init__("\n".join(self.problems))


class _ProblemsError(ValueError):
    """Raised from a model validator to report several problems as separate lines."""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = tuple(problems)
        super().__init__("; ".join(self.problems))


def validation_problems(exc: ValidationError) -> list[str]:
    """One line per problem, prefixed with where it is (`tenants.kestrel.users.3.name`)."""
    lines: list[str] = []
    for error in exc.errors():
        where = ".".join(str(part) for part in error["loc"])
        prefix = f"{where}: " if where else ""
        cause = error.get("ctx", {}).get("error")
        if isinstance(cause, _ProblemsError):
            lines.extend(prefix + problem for problem in cause.problems)
        else:
            lines.append(prefix + error["msg"])
    return lines


class _UniqueKeyLoader(yaml.SafeLoader):
    """PyYAML keeps the last of two equal keys; a hand-edited fixture wants an error instead."""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Hashable, Any]:
        seen: set[object] = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)  # pyright: ignore[reportUnknownMemberType]
            if key in seen:
                raise yaml.constructor.ConstructorError(
                    None, None, f"duplicate key {key!r}", key_node.start_mark
                )
            seen.add(key)
        return super().construct_mapping(node, deep)


def load_yaml(text: str) -> Any:
    return yaml.load(text, Loader=_UniqueKeyLoader)


def path_problem(path: str) -> str | None:
    """Group and folder paths look like `/A/B`: absolute, no trailing slash, no blank names."""
    names = path.split("/")
    if names[0] != "" or len(names) < 2 or any(not n or n != n.strip() for n in names[1:]):
        return f"{path!r} isn't a path like /A/B"
    return None


def parent_path(path: str) -> str:
    return path.rsplit("/", 1)[0] or "/"


class _Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Grant(_Model):
    user: str | None = None
    group: str | None = None
    role: Role

    @model_validator(mode="after")
    def _one_principal(self) -> Self:
        if (self.user is None) == (self.group is None):
            raise ValueError("a grant names exactly one of user or group")
        return self


class Sharing(_Model):
    inherit: bool = True
    grants: tuple[Grant, ...] = ()


class Folder(Sharing):
    path: str


class User(_Model):
    username: str = Field(pattern=USERNAME)
    name: str
    title: str = Field(min_length=1)
    groups: tuple[str, ...]
    roles: tuple[RealmRole, ...] = ("employee",)
    persona: str | None = None
    enabled: bool = True
    _domain: str = PrivateAttr(default="")

    @property
    def email(self) -> str:
        return f"{self.username}@{self._domain}"


class Tenant(_Model):
    name: str = Field(min_length=1)
    domain: str = Field(min_length=1)
    password: str = Field(min_length=1)
    facts: tuple[str, ...] = ()
    groups: tuple[str, ...]
    users: tuple[User, ...]
    folders: tuple[Folder, ...] = ()

    @model_validator(mode="after")
    def _check(self) -> Self:
        problems = self._problems()
        if problems:
            raise _ProblemsError(problems)
        for user in self.users:
            user._domain = self.domain  # pyright: ignore[reportPrivateUsage]
        return self

    def _problems(self) -> list[str]:
        problems: list[str] = []
        groups = set(self.groups)
        for path in _duplicates(self.groups):
            problems.append(f"group {path} is listed twice")
        for path in self.groups:
            if bad := path_problem(path):
                problems.append(f"group {bad}")
            elif (parent := parent_path(path)) != "/" and parent not in groups:
                problems.append(f"group {path} has no parent group {parent}")

        for username in _duplicates(user.username for user in self.users):
            problems.append(f"username {username} is used twice")
        for user in self.users:
            if len(user.name.split(" ")) < 2 or user.name != " ".join(user.name.split()):
                problems.append(
                    f"user {user.username}: name {user.name!r} needs a first and a last name"
                )
            problems.extend(
                f"user {user.username} is in group {group}, which doesn't exist"
                for group in user.groups
                if group not in groups
            )

        folders = {folder.path for folder in self.folders}
        for path in _duplicates(folder.path for folder in self.folders):
            problems.append(f"folder {path} is listed twice")
        for folder in self.folders:
            if folder.path == "/":
                problems.append("folder /: the root can't be listed; it shares nothing")
            elif bad := path_problem(folder.path):
                problems.append(f"folder {bad}")
            elif (parent := parent_path(folder.path)) != "/" and parent not in folders:
                problems.append(f"folder {folder.path} has no parent folder {parent}")
            problems.extend(
                f"folder {folder.path}: {problem}" for problem in self.grant_problems(folder.grants)
            )
        return problems

    def grant_problems(self, grants: Iterable[Grant]) -> list[str]:
        usernames = {user.username for user in self.users}
        problems: list[str] = []
        for grant in grants:
            if grant.user is not None and grant.user not in usernames:
                problems.append(f"grant to unknown user {grant.user}")
            if grant.group is not None and grant.group not in self.groups:
                problems.append(f"grant to unknown group {grant.group}")
        return problems

    def user(self, username: str) -> User:
        for user in self.users:
            if user.username == username:
                return user
        raise KeyError(f"no user {username!r}")

    def folder(self, path: str) -> Folder:
        for folder in self.folders:
            if folder.path == path:
                return folder
        raise KeyError(f"no folder {path!r}")


class ResolvedGrant(_Model):
    principal_type: Literal["user", "group"]
    principal_id: UUID
    principal_name: str
    role: Role
    inherited_from: str | None


class World(_Model):
    version: Literal[1]
    id_namespace: UUID
    today: date
    tenants: dict[Annotated[str, Field(pattern=SLUG)], Tenant]

    def tenant(self, tenant: str) -> Tenant:
        try:
            return self.tenants[tenant]
        except KeyError:
            raise KeyError(f"no tenant {tenant!r}") from None

    def user_id(self, tenant: str, username: str) -> UUID:
        self.tenant(tenant).user(username)
        return self._id(tenant, "user", username)

    def group_id(self, tenant: str, path: str) -> UUID:
        if path not in self.tenant(tenant).groups:
            raise KeyError(f"tenant {tenant!r} has no group {path!r}")
        return self._id(tenant, "group", path)

    def item_id(self, tenant: str, path: str) -> UUID:
        self.tenant(tenant)
        if path != "/" and (bad := path_problem(path)):
            raise ValueError(bad)
        return self._id(tenant, "item", path)

    def effective_grants(self, tenant: str, folder: str) -> tuple[ResolvedGrant, ...]:
        """The parent's grants (when the folder inherits), then its own; the root shares nothing.

        A principal granted more than once keeps its first position and the stronger role; on
        a tie the first grant wins, so access is attributed to the folder it came from.
        """
        if folder == "/":
            return ()
        spec = self.tenant(tenant).folder(folder)
        grants: list[ResolvedGrant] = []
        if spec.inherit:
            parent = parent_path(folder)
            grants.extend(
                grant
                if grant.inherited_from is not None
                else grant.model_copy(update={"inherited_from": parent})
                for grant in self.effective_grants(tenant, parent)
            )
        grants.extend(self._resolve(tenant, grant) for grant in spec.grants)

        merged: dict[tuple[str, UUID], ResolvedGrant] = {}
        for grant in grants:
            key = (grant.principal_type, grant.principal_id)
            current = merged.get(key)
            if current is None or _ROLE_RANK[grant.role] > _ROLE_RANK[current.role]:
                merged[key] = grant
        return tuple(merged.values())

    def _resolve(self, tenant: str, grant: Grant) -> ResolvedGrant:
        if grant.user is not None:
            return ResolvedGrant(
                principal_type="user",
                principal_id=self.user_id(tenant, grant.user),
                principal_name=grant.user,
                role=grant.role,
                inherited_from=None,
            )
        assert grant.group is not None
        return ResolvedGrant(
            principal_type="group",
            principal_id=self.group_id(tenant, grant.group),
            principal_name=grant.group,
            role=grant.role,
            inherited_from=None,
        )

    def _id(self, tenant: str, kind: str, name: str) -> UUID:
        return uuid5(self.id_namespace, f"{tenant}:{kind}:{name}")


def default_world_path() -> Path:
    return find_repo_root() / "fixtures" / "world.yaml"


def load_world(path: Path | None = None) -> World:
    """Read and validate the world, raising `WorldError` with every problem found."""
    path = path or default_world_path()
    try:
        data = load_yaml(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise WorldError([f"{path}: not valid YAML: {exc}"]) from exc
    try:
        return World.model_validate(data)
    except ValidationError as exc:
        raise WorldError(validation_problems(exc)) from exc


def _duplicates(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    repeated: list[str] = []
    for value in values:
        if value in seen and value not in repeated:
            repeated.append(value)
        seen.add(value)
    return repeated
