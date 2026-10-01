import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from ac_core.slots import find_repo_root
from ac_fixtures.directory import realm_export, render, write_realm_exports
from ac_fixtures.world import World, load_world

DIRECTORY = find_repo_root() / "fixtures" / "directory"


@pytest.fixture(scope="module")
def world() -> World:
    return load_world()


def committed(tenant: str) -> dict[str, Any]:
    return json.loads((DIRECTORY / f"{tenant}-realm.json").read_text(encoding="utf-8"))


def users(export: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {user["username"]: user for user in export["users"]}


def walk(groups: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    for group in groups:
        yield group
        yield from walk(group["subGroups"])


def test_committed_exports_equal_the_generator_output(world: World) -> None:
    assert sorted(p.name for p in DIRECTORY.glob("*-realm.json")) == sorted(
        f"{tenant}-realm.json" for tenant in world.tenants
    )
    for tenant in world.tenants:
        text = (DIRECTORY / f"{tenant}-realm.json").read_text(encoding="utf-8")
        assert text == render(realm_export(world, tenant)), (
            f"{tenant}-realm.json is stale: run `uv run python -m ac_fixtures.directory`"
        )


def test_output_is_stable_json() -> None:
    text = render({"b": [1, {"d": 1, "c": 2}], "a": "é"})
    assert (
        text
        == '{\n  "a": "é",\n  "b": [\n    1,\n    {\n      "c": 2,\n      "d": 1\n    }\n  ]\n}\n'
    )


def test_write_touches_only_changed_files(world: World, tmp_path: Path) -> None:
    written = write_realm_exports(world, tmp_path)
    assert written == [tmp_path / f"{tenant}-realm.json" for tenant in world.tenants]
    assert write_realm_exports(world, tmp_path) == []
    (tmp_path / "harbour-realm.json").write_text("{}\n", encoding="utf-8")
    assert write_realm_exports(world, tmp_path) == [tmp_path / "harbour-realm.json"]
    assert (tmp_path / "kestrel-realm.json").read_text(encoding="utf-8") == render(
        realm_export(world, "kestrel")
    )


@pytest.mark.parametrize("tenant", ["kestrel", "harbour"])
def test_user_and_group_ids_are_the_world_ids(world: World, tenant: str) -> None:
    export = committed(tenant)
    exported = {name: user for name, user in users(export).items() if name != f"smoke.{tenant}"}
    assert list(exported) == [user.username for user in world.tenants[tenant].users]
    for name, user in exported.items():
        assert user["id"] == str(world.user_id(tenant, name))
    groups = list(walk(export["groups"]))
    assert [group["path"] for group in groups] == list(world.tenants[tenant].groups)
    for group in groups:
        assert group["id"] == str(world.group_id(tenant, group["path"]))
        assert group["name"] == group["path"].rsplit("/", 1)[1]


def test_groups_nest_under_their_parents() -> None:
    (root,) = committed("kestrel")["groups"]
    assert root["path"] == "/Kestrel"
    children = {group["name"]: group for group in root["subGroups"]}
    assert list(children) == ["Exec", "Finance", "Engineering", "HR", "Legal", "Sales"]
    assert [g["path"] for g in children["Finance"]["subGroups"]] == [
        "/Kestrel/Finance/AP",
        "/Kestrel/Finance/FP&A",
    ]
    assert children["Exec"]["subGroups"] == []


def test_users_carry_profile_memberships_roles_and_password(world: World) -> None:
    kestrel = users(committed("kestrel"))
    assert kestrel["leo.martin"] == {
        "id": str(world.user_id("kestrel", "leo.martin")),
        "username": "leo.martin",
        "enabled": True,
        "email": "leo.martin@kestrelpay.example",
        "emailVerified": True,
        "firstName": "Leo",
        "lastName": "Martin",
        "attributes": {"title": ["Finance Intern"]},
        "credentials": [{"type": "password", "value": "dev-password", "temporary": False}],
        "realmRoles": ["employee"],
        "groups": ["/Kestrel/Finance/AP"],
    }
    assert kestrel["daniel.reyes"]["groups"] == ["/Kestrel/Exec", "/Kestrel/Finance"]
    assert kestrel["ella.brooks"]["groups"] == ["/Kestrel"]
    assert kestrel["tariq.aziz"]["realmRoles"] == ["employee", "admin"]
    harbour = users(committed("harbour"))
    assert harbour["sam.patel"]["email"] == "sam.patel@harbourhealth.example"
    assert harbour["sam.patel"]["id"] != kestrel["sam.patel"]["id"]
    assert harbour["isla.mcgregor"]["lastName"] == "McGregor"


def test_only_the_leaver_is_disabled() -> None:
    disabled = [name for name, user in users(committed("kestrel")).items() if not user["enabled"]]
    assert disabled == ["peter.hall"]
    assert users(committed("kestrel"))["peter.hall"]["groups"] == ["/Kestrel/Finance/FP&A"]
    assert all(user["enabled"] for user in committed("harbour")["users"])


@pytest.mark.parametrize("tenant", ["kestrel", "harbour"])
def test_m0a_setup_is_kept(tenant: str) -> None:
    export = committed(tenant)
    assert export["realm"] == tenant
    assert export["enabled"] is True
    assert export["roles"] == {
        "realm": [
            {"name": "admin", "description": "Workspace administrator"},
            {"name": "employee", "description": "Every staff member"},
        ]
    }
    (client,) = export["clients"]
    mappers = {mapper["name"]: mapper for mapper in client.pop("protocolMappers")}
    assert client == {
        "clientId": "web-bff",
        "name": "Web BFF",
        "enabled": True,
        "protocol": "openid-connect",
        "publicClient": False,
        "clientAuthenticatorType": "client-secret",
        "secret": "dev-web-bff-secret",
        "standardFlowEnabled": True,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": False,
        "redirectUris": ["http://localhost:3000/auth/callback"],
        "webOrigins": ["http://localhost:3000"],
        "attributes": {
            "pkce.code.challenge.method": "S256",
            "post.logout.redirect.uris": "http://localhost:3000/",
        },
    }
    audience = mappers["audience-agentic-api"]
    assert audience["protocolMapper"] == "oidc-audience-mapper"
    assert audience["config"]["included.custom.audience"] == "agentic-api"
    assert audience["config"]["access.token.claim"] == "true"
    claim = mappers["tenant"]
    assert claim["protocolMapper"] == "oidc-hardcoded-claim-mapper"
    assert claim["config"]["claim.name"] == "tenant"
    assert claim["config"]["claim.value"] == tenant
    assert claim["config"]["access.token.claim"] == "true"
    assert users(export)[f"smoke.{tenant}"] == {
        "username": f"smoke.{tenant}",
        "enabled": True,
        "email": f"smoke.{tenant}@{tenant}.example",
        "emailVerified": True,
        "firstName": "Smoke",
        "lastName": tenant.capitalize(),
        "credentials": [{"type": "password", "value": "smoke-password", "temporary": False}],
        "realmRoles": ["employee"],
    }


def test_the_user_profile_declares_title() -> None:
    (component,) = committed("kestrel")["components"][
        "org.keycloak.userprofile.UserProfileProvider"
    ]
    assert component["providerId"] == "declarative-user-profile"
    (raw,) = component["config"]["kc.user.profile.config"]
    attributes = {attribute["name"]: attribute for attribute in json.loads(raw)["attributes"]}
    assert list(attributes) == ["username", "email", "firstName", "lastName", "title"]
    assert attributes["title"]["permissions"] == {"view": ["admin", "user"], "edit": ["admin"]}
