"""manifest.json: every folder and file on each tenant's site, with the item's own sharing,
and the tenant's users so fake-workspace can name them as Graph does.

fake-workspace reads it and works out inheritance itself, so grants here are never resolved
through parents. Ids come from the world, so they agree with Keycloak without a lookup table.
"""

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from uuid import UUID

from ac_fixtures.sources import Source
from ac_fixtures.world import Grant, Tenant, World, parent_path

VERSION = 1
ROOT = "/"


@dataclass(frozen=True)
class Blob:
    path: str  # "blobs/<sha256>.<ext>", relative to the build directory
    sha256: str
    size: int
    mime_type: str
    pages: int | None


def file_times(
    tenant: str, doc_id: str, created: date, modified: date
) -> tuple[datetime, datetime]:
    """The frontmatter dates at a time of day fixed by the id: created in the morning and
    modified in the afternoon, so a same-day edit still comes after its creation."""
    digest = hashlib.sha256(f"{tenant}:{doc_id}".encode()).digest()
    morning = 8 * 60 + int.from_bytes(digest[:2]) % 240
    afternoon = 13 * 60 + int.from_bytes(digest[2:4]) % 300
    return _at(created, morning), _at(modified, afternoon)


def build_manifest(world: World, sources: list[Source], blobs: dict[str, Blob]) -> dict[str, Any]:
    """`blobs` maps "<tenant>/<doc id>" to the rendered file."""
    sites: dict[str, Any] = {}
    for tenant, spec in world.tenants.items():
        items = [_folder(world, tenant, spec, ROOT)]
        items += [_folder(world, tenant, spec, folder.path) for folder in spec.folders]
        items += [
            _file(world, source, blobs[f"{tenant}/{source.meta.id}"])
            for source in sources
            if source.tenant == tenant
        ]
        items.sort(key=lambda item: _parts(item["path"]))
        users = {
            str(world.user_id(tenant, user.username)): {
                "username": user.username,
                "display_name": user.name,
            }
            for user in spec.users
        }
        sites[tenant] = {"items": items, "users": users}
    return {"version": VERSION, "sites": sites}


def dumps(manifest: dict[str, Any]) -> bytes:
    return (json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


def _folder(world: World, tenant: str, spec: Tenant, path: str) -> dict[str, Any]:
    author = str(_folder_author(world, tenant, spec, path))
    when = _stamp(_at(world.today, 0))
    if path == ROOT:
        sharing: dict[str, Any] = {"inherit": False, "grants": []}
    else:
        folder = spec.folder(path)
        sharing = _sharing(world, tenant, folder.inherit, folder.grants)
    return {
        "id": str(world.item_id(tenant, path)),
        "path": path,
        "name": "root" if path == ROOT else path.rsplit("/", 1)[1],
        "parent_id": None if path == ROOT else str(world.item_id(tenant, parent_path(path))),
        "kind": "folder",
        "created": when,
        "modified": when,
        "created_by": author,
        "modified_by": author,
        "sharing": sharing,
    }


def _file(world: World, source: Source, blob: Blob) -> dict[str, Any]:
    meta, tenant = source.meta, source.tenant
    path = f"{meta.folder}/{meta.filename}"
    created, modified = file_times(tenant, meta.id, meta.created, meta.modified)
    author = str(world.user_id(tenant, meta.author))
    permissions = meta.permissions
    file: dict[str, Any] = {
        "mime_type": blob.mime_type,
        "size": blob.size,
        "sha256": blob.sha256,
        "blob": blob.path,
    }
    if blob.pages is not None:
        file["pages"] = blob.pages
    return {
        "id": str(world.item_id(tenant, path)),
        "path": path,
        "name": meta.filename,
        "parent_id": str(world.item_id(tenant, meta.folder)),
        "kind": "file",
        "created": _stamp(created),
        "modified": _stamp(modified),
        "created_by": author,
        "modified_by": author,
        "file": file,
        "doc_id": meta.id,
        "format": meta.format,
        "traps": list(meta.traps),
        "valid_from": meta.valid_from.isoformat() if meta.valid_from else None,
        "valid_to": meta.valid_to.isoformat() if meta.valid_to else None,
        "sharing": _sharing(
            world,
            tenant,
            permissions.inherit if permissions else True,
            permissions.grants if permissions else (),
        ),
    }


def _sharing(world: World, tenant: str, inherit: bool, grants: tuple[Grant, ...]) -> dict[str, Any]:
    resolved: list[dict[str, str]] = []
    for grant in grants:
        if grant.user is not None:
            kind, name, principal = "user", grant.user, world.user_id(tenant, grant.user)
        else:
            assert grant.group is not None
            kind, name, principal = "group", grant.group, world.group_id(tenant, grant.group)
        resolved.append(
            {
                "principal_type": kind,
                "principal_id": str(principal),
                "principal_name": name,
                "role": grant.role,
            }
        )
    return {"inherit": inherit, "grants": resolved}


def _folder_author(world: World, tenant: str, spec: Tenant, path: str) -> UUID:
    """The first write grant's user, or for a group its first enabled member (directly or
    through a subgroup). The folder's own grants come before the ones it inherits; the root,
    which nobody is granted, falls back to the first admin."""
    grants = () if path == ROOT else world.effective_grants(tenant, path)
    for grant in sorted(grants, key=lambda g: g.inherited_from is not None):
        if grant.role != "write":
            continue
        if grant.principal_type == "user":
            return grant.principal_id
        group = grant.principal_name
        for user in spec.users:
            if user.enabled and any(g == group or g.startswith(f"{group}/") for g in user.groups):
                return world.user_id(tenant, user.username)
    enabled = [user for user in spec.users if user.enabled]
    admin = next((user for user in enabled if "admin" in user.roles), enabled[0])
    return world.user_id(tenant, admin.username)


def _at(day: date, minutes: int) -> datetime:
    return datetime.combine(day, time(0, 0), tzinfo=UTC) + timedelta(minutes=minutes)


def _stamp(when: datetime) -> str:
    return f"{when:%Y-%m-%dT%H:%M:%S}Z"


def _parts(path: str) -> tuple[str, ...]:
    return tuple(part for part in path.split("/") if part)
