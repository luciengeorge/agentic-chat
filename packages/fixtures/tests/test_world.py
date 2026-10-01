import copy
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

import pytest
import yaml

from ac_fixtures.world import ResolvedGrant, World, WorldError, load_world

NAMESPACE = UUID("7d491e87-db78-4901-a173-34260d9df5d1")

BASE: dict[str, Any] = {
    "version": 1,
    "id_namespace": str(NAMESPACE),
    "today": "2026-09-30",
    "tenants": {
        "acme": {
            "name": "Acme",
            "domain": "acme.example",
            "password": "pw",
            "groups": ["/Acme", "/Acme/Ops", "/Acme/Ops/Night"],
            "users": [
                {
                    "username": "ann.lee",
                    "name": "Ann Lee",
                    "title": "Boss",
                    "groups": ["/Acme/Ops"],
                },
                {
                    "username": "bob.ray",
                    "name": "Bob Ray",
                    "title": "Night Lead",
                    "groups": ["/Acme/Ops/Night"],
                    "roles": ["employee", "admin"],
                    "enabled": False,
                },
            ],
            "folders": [
                {
                    "path": "/Ops",
                    "grants": [
                        {"group": "/Acme/Ops", "role": "read"},
                        {"user": "ann.lee", "role": "write"},
                    ],
                },
                {
                    "path": "/Ops/Night",
                    "grants": [
                        {"group": "/Acme/Ops/Night", "role": "write"},
                        {"group": "/Acme/Ops", "role": "write"},
                    ],
                },
                {"path": "/Ops/Night/Logs"},
                {
                    "path": "/Ops/Private",
                    "inherit": False,
                    "grants": [
                        {"user": "bob.ray", "role": "read"},
                        {"user": "bob.ray", "role": "write"},
                    ],
                },
                {
                    "path": "/Shared",
                    "grants": [
                        {"group": "/Acme", "role": "read"},
                        {"group": "/Acme", "role": "read"},
                    ],
                },
            ],
        },
        "zeta": {
            "name": "Zeta",
            "domain": "zeta.example",
            "password": "pw",
            "groups": ["/Zeta"],
            "users": [{"username": "ann.lee", "name": "Ann Lee", "title": "Ops", "groups": []}],
        },
    },
}


def write(tmp_path: Path, data: object) -> Path:
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


@pytest.fixture
def world(tmp_path: Path) -> World:
    return load_world(write(tmp_path, BASE))


def problems_for(tmp_path: Path, data: object) -> tuple[str, ...]:
    with pytest.raises(WorldError) as info:
        load_world(write(tmp_path, data))
    return info.value.problems


def test_the_committed_world_loads() -> None:
    world = load_world()
    assert set(world.tenants) == {"kestrel", "harbour"}
    assert world.tenants["kestrel"].user("peter.hall").enabled is False
    assert world.tenants["kestrel"].user("tariq.aziz").roles == ("employee", "admin")
    assert world.tenants["kestrel"].user("leo.martin").email == "leo.martin@kestrelpay.example"


def test_ids_are_uuid5_of_tenant_kind_and_name(world: World) -> None:
    assert world.user_id("acme", "ann.lee") == uuid5(NAMESPACE, "acme:user:ann.lee")
    assert world.group_id("acme", "/Acme/Ops") == uuid5(NAMESPACE, "acme:group:/Acme/Ops")
    assert world.item_id("acme", "/") == uuid5(NAMESPACE, "acme:item:/")
    assert world.item_id("acme", "/Ops/a.pdf") == uuid5(NAMESPACE, "acme:item:/Ops/a.pdf")
    assert world.user_id("acme", "ann.lee") != world.user_id("zeta", "ann.lee")


def test_committed_ids_never_change() -> None:
    world = load_world()
    assert world.user_id("kestrel", "leo.martin") == UUID("0ae8fa04-8d89-5fd9-b3f0-17a15e8a72f6")
    assert world.group_id("kestrel", "/Kestrel/Exec") == UUID(
        "0c0199be-c8c7-5561-a0d7-6c1424e5565b"
    )


def test_unknown_names_raise(world: World) -> None:
    with pytest.raises(KeyError, match="nobody"):
        world.user_id("acme", "nobody")
    with pytest.raises(KeyError, match="/Acme/Nope"):
        world.group_id("acme", "/Acme/Nope")
    with pytest.raises(KeyError, match="globex"):
        world.item_id("globex", "/")
    with pytest.raises(ValueError, match="isn't a path"):
        world.item_id("acme", "Ops/")
    with pytest.raises(KeyError, match="/Nope"):
        world.effective_grants("acme", "/Nope")


def test_user_defaults_and_email(world: World) -> None:
    ann = world.tenants["acme"].user("ann.lee")
    assert (ann.roles, ann.enabled, ann.persona) == (("employee",), True, None)
    assert ann.email == "ann.lee@acme.example"
    assert world.tenants["zeta"].user("ann.lee").email == "ann.lee@zeta.example"


def grant(
    world: World, kind: str, name: str, role: str, inherited_from: str | None
) -> ResolvedGrant:
    principal_id = world.user_id("acme", name) if kind == "user" else world.group_id("acme", name)
    return ResolvedGrant.model_validate(
        {
            "principal_type": kind,
            "principal_id": principal_id,
            "principal_name": name,
            "role": role,
            "inherited_from": inherited_from,
        }
    )


def test_root_shares_nothing(world: World) -> None:
    assert world.effective_grants("acme", "/") == ()


def test_own_grants_have_no_origin(world: World) -> None:
    assert world.effective_grants("acme", "/Ops") == (
        grant(world, "group", "/Acme/Ops", "read", None),
        grant(world, "user", "ann.lee", "write", None),
    )


def test_inherited_grants_come_first_and_a_stronger_own_grant_wins(world: World) -> None:
    assert world.effective_grants("acme", "/Ops/Night") == (
        grant(world, "group", "/Acme/Ops", "write", None),
        grant(world, "user", "ann.lee", "write", "/Ops"),
        grant(world, "group", "/Acme/Ops/Night", "write", None),
    )


def test_inheritance_reaches_through_grandparents(world: World) -> None:
    assert world.effective_grants("acme", "/Ops/Night/Logs") == (
        grant(world, "group", "/Acme/Ops", "write", "/Ops/Night"),
        grant(world, "user", "ann.lee", "write", "/Ops"),
        grant(world, "group", "/Acme/Ops/Night", "write", "/Ops/Night"),
    )


def test_inherit_false_drops_the_parent(world: World) -> None:
    assert world.effective_grants("acme", "/Ops/Private") == (
        grant(world, "user", "bob.ray", "write", None),
    )


def test_duplicate_principal_with_equal_roles_appears_once(world: World) -> None:
    assert world.effective_grants("acme", "/Shared") == (
        grant(world, "group", "/Acme", "read", None),
    )


def test_committed_world_sharing() -> None:
    world = load_world()
    fpa = world.effective_grants("kestrel", "/Finance/FP&A")
    assert [(g.principal_name, g.role, g.inherited_from) for g in fpa] == [
        ("/Kestrel/Finance/FP&A", "write", None),
        ("daniel.reyes", "read", None),
    ]
    casework = world.effective_grants("kestrel", "/HR/Casework")
    assert [(g.principal_name, g.inherited_from) for g in casework] == [("/Kestrel/HR", "/HR")]


def mutated(change: str) -> dict[str, Any]:
    data = copy.deepcopy(BASE)
    acme = data["tenants"]["acme"]
    match change:
        case "group parent":
            acme["groups"].append("/Acme/Sales/EMEA")
        case "group path":
            acme["groups"].append("/Acme/")
        case "group twice":
            acme["groups"].append("/Acme/Ops")
        case "username twice":
            acme["users"].append(dict(acme["users"][0], title="Clone"))
        case "unknown user group":
            acme["users"][0]["groups"] = ["/Acme/Ghosts"]
        case "single name":
            acme["users"][0]["name"] = "Ann"
        case "folder parent":
            acme["folders"].append({"path": "/Sales/EMEA"})
        case "root folder":
            acme["folders"].append({"path": "/"})
        case "folder twice":
            acme["folders"].append({"path": "/Ops"})
        case "grant user":
            acme["folders"][0]["grants"].append({"user": "zed.zed", "role": "read"})
        case "grant group":
            acme["folders"][0]["grants"].append({"group": "/Zeta", "role": "read"})
        case "grant both":
            acme["folders"][0]["grants"].append(
                {"user": "ann.lee", "group": "/Acme", "role": "read"}
            )
        case "grant role":
            acme["folders"][0]["grants"][0]["role"] = "owner"
        case "realm role":
            acme["users"][0]["roles"] = ["superuser"]
        case "extra field":
            acme["users"][0]["nickname"] = "annie"
        case "username case":
            acme["users"][0]["username"] = "Ann.Lee"
        case "tenant slug":
            data["tenants"]["Acme Corp"] = data["tenants"].pop("zeta")
        case "version":
            data["version"] = 2
        case _:
            raise AssertionError(change)
    return data


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ("group parent", "group /Acme/Sales/EMEA has no parent group /Acme/Sales"),
        ("group path", "group '/Acme/' isn't a path like /A/B"),
        ("group twice", "group /Acme/Ops is listed twice"),
        ("username twice", "username ann.lee is used twice"),
        ("unknown user group", "user ann.lee is in group /Acme/Ghosts, which doesn't exist"),
        ("single name", "user ann.lee: name 'Ann' needs a first and a last name"),
        ("folder parent", "folder /Sales/EMEA has no parent folder /Sales"),
        ("root folder", "folder /: the root can't be listed"),
        ("folder twice", "folder /Ops is listed twice"),
        ("grant user", "folder /Ops: grant to unknown user zed.zed"),
        ("grant group", "folder /Ops: grant to unknown group /Zeta"),
        ("grant both", "a grant names exactly one of user or group"),
        ("grant role", "tenants.acme.folders.0.grants.0.role: Input should be 'read' or 'write'"),
        ("realm role", "tenants.acme.users.0.roles.0: Input should be 'employee' or 'admin'"),
        ("extra field", "tenants.acme.users.0.nickname: Extra inputs are not permitted"),
        ("username case", "tenants.acme.users.0.username: String should match pattern"),
        ("tenant slug", "tenants.Acme Corp.[key]: String should match pattern"),
        ("version", "version: Input should be 1"),
    ],
)
def test_each_problem_is_reported(tmp_path: Path, change: str, expected: str) -> None:
    problems = problems_for(tmp_path, mutated(change))
    assert any(expected in problem for problem in problems), problems


def test_every_problem_is_reported_at_once(tmp_path: Path) -> None:
    data = copy.deepcopy(BASE)
    acme, zeta = data["tenants"]["acme"], data["tenants"]["zeta"]
    acme["groups"].append("/Acme/Sales/EMEA")
    acme["users"][0]["groups"] = ["/Acme/Ghosts"]
    acme["folders"][0]["grants"].append({"user": "zed.zed", "role": "read"})
    zeta["users"][0]["title"] = ""
    problems = problems_for(tmp_path, data)
    assert problems == (
        "tenants.acme: group /Acme/Sales/EMEA has no parent group /Acme/Sales",
        "tenants.acme: user ann.lee is in group /Acme/Ghosts, which doesn't exist",
        "tenants.acme: folder /Ops: grant to unknown user zed.zed",
        "tenants.zeta.users.0.title: String should have at least 1 character",
    )


def test_duplicate_yaml_keys_are_refused(tmp_path: Path) -> None:
    path = tmp_path / "world.yaml"
    path.write_text("version: 1\nversion: 1\n", encoding="utf-8")
    with pytest.raises(WorldError, match="duplicate key 'version'"):
        load_world(path)


def test_invalid_yaml_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "world.yaml"
    path.write_text("tenants: [\n", encoding="utf-8")
    with pytest.raises(WorldError, match="not valid YAML"):
        load_world(path)


def test_world_is_frozen(world: World) -> None:
    with pytest.raises(ValueError, match="frozen"):
        world.today = world.today  # pyright: ignore[reportAttributeAccessIssue]
