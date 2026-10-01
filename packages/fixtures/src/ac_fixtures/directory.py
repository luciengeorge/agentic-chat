"""Keycloak realm exports (`fixtures/directory/<tenant>-realm.json`), generated from the world.

Each realm keeps what M0a set up (the `web-bff` client with its audience and tenant mappers, the
realm roles and the smoke user) and adds the world's groups and users under their fixed ids.
`python -m ac_fixtures.directory` rewrites the exports and prints the files it changed.
"""

import json
from pathlib import Path
from typing import Any

from ac_core.slots import find_repo_root
from ac_fixtures.world import User, World, load_world, parent_path

WEB_ORIGIN = "http://localhost:3000"


def default_directory() -> Path:
    return find_repo_root() / "fixtures" / "directory"


def realm_export(world: World, tenant: str) -> dict[str, Any]:
    spec = world.tenant(tenant)
    return {
        "realm": tenant,
        "displayName": spec.name,
        "enabled": True,
        "roles": {
            "realm": [
                {"name": "admin", "description": "Workspace administrator"},
                {"name": "employee", "description": "Every staff member"},
            ]
        },
        "components": {"org.keycloak.userprofile.UserProfileProvider": [_user_profile()]},
        "clients": [_web_bff(tenant)],
        "groups": _groups(world, tenant),
        "users": [_smoke_user(tenant), *(_user(world, tenant, user) for user in spec.users)],
    }


def render(export: dict[str, Any]) -> str:
    return json.dumps(export, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write_realm_exports(world: World | None = None, out_dir: Path | None = None) -> list[Path]:
    """Write every tenant's export, touching only files whose content changed; returns those."""
    world = world or load_world()
    out_dir = out_dir or default_directory()
    out_dir.mkdir(parents=True, exist_ok=True)
    changed: list[Path] = []
    for tenant in world.tenants:
        path = out_dir / f"{tenant}-realm.json"
        text = render(realm_export(world, tenant))
        if not path.is_file() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
            changed.append(path)
    return changed


def _groups(world: World, tenant: str) -> list[dict[str, Any]]:
    children: dict[str, list[str]] = {}
    for path in world.tenant(tenant).groups:
        children.setdefault(parent_path(path), []).append(path)

    def group(path: str) -> dict[str, Any]:
        return {
            "id": str(world.group_id(tenant, path)),
            "name": path.rsplit("/", 1)[1],
            "path": path,
            "subGroups": [group(child) for child in children.get(path, [])],
        }

    return [group(path) for path in children.get("/", [])]


def _user(world: World, tenant: str, user: User) -> dict[str, Any]:
    first_name, last_name = user.name.split(" ", 1)
    return {
        "id": str(world.user_id(tenant, user.username)),
        "username": user.username,
        "enabled": user.enabled,
        "email": user.email,
        "emailVerified": True,
        "firstName": first_name,
        "lastName": last_name,
        "attributes": {"title": [user.title]},
        "credentials": [_password(world.tenant(tenant).password)],
        "realmRoles": list(user.roles),
        "groups": list(user.groups),
    }


def _password(value: str) -> dict[str, Any]:
    return {"type": "password", "value": value, "temporary": False}


def _smoke_user(tenant: str) -> dict[str, Any]:
    return {
        "username": f"smoke.{tenant}",
        "enabled": True,
        "email": f"smoke.{tenant}@{tenant}.example",
        "emailVerified": True,
        "firstName": "Smoke",
        "lastName": tenant.capitalize(),
        "credentials": [_password("smoke-password")],
        "realmRoles": ["employee"],
    }


def _web_bff(tenant: str) -> dict[str, Any]:
    return {
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
        "redirectUris": [f"{WEB_ORIGIN}/auth/callback"],
        "webOrigins": [WEB_ORIGIN],
        "attributes": {
            "pkce.code.challenge.method": "S256",
            "post.logout.redirect.uris": f"{WEB_ORIGIN}/",
        },
        "protocolMappers": [
            {
                "name": "audience-agentic-api",
                "protocol": "openid-connect",
                "protocolMapper": "oidc-audience-mapper",
                "config": {
                    "included.custom.audience": "agentic-api",
                    "access.token.claim": "true",
                    "id.token.claim": "false",
                    "introspection.token.claim": "true",
                },
            },
            {
                "name": "tenant",
                "protocol": "openid-connect",
                "protocolMapper": "oidc-hardcoded-claim-mapper",
                "config": {
                    "claim.name": "tenant",
                    "claim.value": tenant,
                    "jsonType.label": "String",
                    "access.token.claim": "true",
                    "id.token.claim": "true",
                    "userinfo.token.claim": "true",
                    "introspection.token.claim": "true",
                },
            },
        ],
    }


def _user_profile() -> dict[str, Any]:
    """Keycloak's default user profile plus `title`.

    Since Keycloak 24 an attribute the profile doesn't declare is kept on import but hidden
    from the admin API, so `title` has to be declared. The config replaces the default one
    wholesale, hence the four built-in attributes.
    """
    everyone = {"view": ["admin", "user"], "edit": ["admin", "user"]}
    name_rules = {"length": {"max": 255}, "person-name-prohibited-characters": {}}
    attributes = [
        {
            "name": "username",
            "displayName": "${username}",
            "validations": {
                "length": {"min": 3, "max": 255},
                "username-prohibited-characters": {},
                "up-username-not-idn-homograph": {},
            },
            "permissions": everyone,
            "multivalued": False,
        },
        {
            "name": "email",
            "displayName": "${email}",
            "validations": {"email": {}, "length": {"max": 255}},
            "required": {"roles": ["user"]},
            "permissions": everyone,
            "multivalued": False,
        },
        {
            "name": "firstName",
            "displayName": "${firstName}",
            "validations": name_rules,
            "required": {"roles": ["user"]},
            "permissions": everyone,
            "multivalued": False,
        },
        {
            "name": "lastName",
            "displayName": "${lastName}",
            "validations": name_rules,
            "required": {"roles": ["user"]},
            "permissions": everyone,
            "multivalued": False,
        },
        {
            "name": "title",
            "displayName": "Job title",
            "validations": {"length": {"max": 255}},
            "permissions": {"view": ["admin", "user"], "edit": ["admin"]},
            "multivalued": False,
        },
    ]
    config = {
        "attributes": attributes,
        "groups": [
            {
                "name": "user-metadata",
                "displayHeader": "User metadata",
                "displayDescription": "Attributes, which refer to user metadata",
            }
        ],
    }
    return {
        "providerId": "declarative-user-profile",
        "subComponents": {},
        "config": {"kc.user.profile.config": [json.dumps(config, sort_keys=True)]},
    }


def main() -> int:
    changed = write_realm_exports()
    root = find_repo_root()
    for path in changed:
        print(path.relative_to(root))
    if not changed:
        print("realm exports unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
