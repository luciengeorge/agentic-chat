"""The Graph-shaped API a connector sees: `/v1.0/sites/{site}/drive/...` and subscriptions."""

import base64
import binascii
import bisect
import json
import re
import uuid
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import FileResponse

from ac_fake_workspace.delivery import Notifier, SubscriptionRenewal, SubscriptionRequest
from ac_fake_workspace.errors import GraphError, bad_request
from ac_fake_workspace.faults import Faults
from ac_fake_workspace.state import (
    NAMESPACE,
    Clock,
    Effective,
    Item,
    Site,
    Workspace,
    iso,
    sort_key,
)

DEFAULT_PAGE = 20
MAX_PAGE = 200
CONTROL_APP = {"id": str(uuid.uuid5(NAMESPACE, "control")), "displayName": "fake-workspace"}

type JSON = dict[str, Any]


@dataclass
class Runtime:
    env: str
    clock: Clock
    workspace: Workspace
    faults: Faults
    notifier: Notifier


async def runtime(request: Request) -> Runtime:
    # Every dependency and handler is async, so state is only ever touched from the event loop.
    return request.app.state.runtime


RuntimeDep = Annotated[Runtime, Depends(runtime)]


def not_ready() -> GraphError:
    return GraphError(503, "serviceNotReady", "No corpus is loaded yet.")


async def authorize(rt: RuntimeDep, authorization: Annotated[str | None, Header()] = None) -> str:
    """The site the bearer token opens."""
    if not rt.workspace.loaded:
        raise not_ready()
    scheme, _, token = (authorization or "").partition(" ")
    site = rt.workspace.site_for_token(token) if scheme.lower() == "bearer" else None
    if site is None:
        message = "Access token is empty or invalid."
        raise GraphError(401, "InvalidAuthenticationToken", message, {"WWW-Authenticate": "Bearer"})
    return site


async def site_access(
    site: str, request: Request, rt: RuntimeDep, token_site: Annotated[str, Depends(authorize)]
) -> Site:
    if token_site != site:
        raise GraphError(403, "accessDenied", "The token can't open this site.")
    await rt.faults.apply(site, request.url.path)
    # An injected wait can outlast a reset, and a failed reset leaves no corpus.
    drive = rt.workspace.sites.get(site)
    if drive is None:
        raise not_ready()
    return drive


async def subscriber(
    request: Request, rt: RuntimeDep, site: Annotated[str, Depends(authorize)]
) -> str:
    await rt.faults.apply(site, request.url.path)
    return site


async def item_ref(request: Request) -> str:
    """The item a route names; `root` works as an id, and the `/drive/root` routes imply it."""
    return request.path_params.get("item_id", "root")


SiteDep = Annotated[Site, Depends(site_access)]
RefDep = Annotated[str, Depends(item_ref)]
Top = Annotated[int, Query(alias="$top", ge=1)]


def identity(site: Site, user_id: str | None) -> JSON:
    if user_id is None:
        return {"application": CONTROL_APP}
    return {"user": {"id": user_id, "displayName": site.users[user_id]}}


def drive_item(site: Site, item: Item, *, delta: bool = False) -> JSON:
    """A driveItem. In delta, parentReference has no path and files have no cTag, as in
    SharePoint: renaming a folder doesn't return its descendants, so paths there would go stale."""
    body: JSON = {"id": item.id, "name": item.name, "eTag": item.etag}
    if not item.folder and not delta:
        body["cTag"] = item.ctag
    body |= {
        "createdDateTime": iso(item.created),
        "lastModifiedDateTime": iso(item.modified),
        "size": site.size(item),
        "createdBy": identity(site, item.created_by),
        "lastModifiedBy": identity(site, item.modified_by),
    }
    if item.parent_id is None:
        body["root"] = {}
    else:
        parent = site.items[item.parent_id]
        body["parentReference"] = {"id": parent.id}
        if not delta:
            body["parentReference"]["path"] = site.drive_path(parent)
    if item.folder:
        body["folder"] = {"childCount": len(site.children(item))}
    else:
        hashes = {"sha256Hash": (item.sha256 or "").upper()}
        body["file"] = {"mimeType": item.mime_type, "hashes": hashes}
    return body


def permission(site: Site, item: Item, effective: Effective) -> JSON:
    grant, source = effective.grant, effective.source
    granted_by = source or item
    key = f"permission:{granted_by.id}:{grant.principal_type}:{grant.principal_id}"
    if grant.principal_type == "user":
        granted = {
            "user": {"id": grant.principal_id, "displayName": site.users[grant.principal_id]}
        }
    else:
        granted = {"group": {"id": grant.principal_id, "displayName": grant.principal_name}}
    body: JSON = {
        "id": str(uuid.uuid5(NAMESPACE, key)),
        "roles": [grant.role],
        "grantedToV2": granted,
    }
    if source is not None:
        body["inheritedFrom"] = {"id": source.id, "path": site.drive_path(source)}
    return body


def _link(request: Request, **changes: str | None) -> str:
    """The request's URL with query parameters set, or removed with None. `$` stays literal, as in
    Graph's links (`?$top=2&$skiptoken=...`)."""
    query = {**request.query_params, **changes}
    kept = {key: value for key, value in query.items() if value is not None}
    return str(request.url.replace(query=urlencode(kept, safe="$")))


def _encode(*parts: object) -> str:
    raw = ".".join(str(p) for p in parts).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(token: str) -> str:
    try:
        return base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as e:
        raise bad_request("Invalid token.") from e


def _after(skiptoken: str) -> tuple[str, str]:
    """The sort key a children `$skiptoken` carries: the last child already returned."""
    try:
        name, item_id = json.loads(_decode(skiptoken))
    except (ValueError, TypeError) as e:  # not JSON, or not a pair
        raise bad_request("Invalid $skiptoken.") from e
    if not isinstance(name, str) or not isinstance(item_id, str):
        raise bad_request("Invalid $skiptoken.")
    return name, item_id


router = APIRouter(prefix="/v1.0")


@router.get("/sites/{site}/drive/root")
@router.get("/sites/{site}/drive/items/{item_id}")
async def get_item(drive: SiteDep, ref: RefDep) -> JSON:
    return drive_item(drive, drive.get(ref))


@router.get("/sites/{site}/drive/root/children")
@router.get("/sites/{site}/drive/items/{item_id}/children")
async def list_children(
    request: Request,
    drive: SiteDep,
    ref: RefDep,
    top: Top = DEFAULT_PAGE,
    skiptoken: Annotated[str | None, Query(alias="$skiptoken")] = None,
) -> JSON:
    """Sorted by name (case-insensitive), then id, and paged by that key: the `$skiptoken` holds
    the last child returned, and the next page starts after it. An offset would shift when a
    child is deleted or added between pages, skipping or repeating one."""
    item = drive.get(ref)
    top = min(top, MAX_PAGE)
    children = drive.children(item)
    start = 0
    if skiptoken is not None:
        start = bisect.bisect_right([sort_key(c) for c in children], _after(skiptoken))
    page = children[start : start + top]
    body: JSON = {"value": [drive_item(drive, c) for c in page]}
    if start + top < len(children):
        last = json.dumps(sort_key(page[-1]), ensure_ascii=False)
        body["@odata.nextLink"] = _link(request, **{"$skiptoken": _encode(last)})
    return body


@router.get("/sites/{site}/drive/root/content")
@router.get("/sites/{site}/drive/items/{item_id}/content")
async def get_content(drive: SiteDep, ref: RefDep) -> Response:
    item = drive.get(ref)
    if item.folder:
        raise bad_request("A folder has no content.")
    if item.content is not None:
        return Response(item.content, media_type=item.mime_type)
    assert item.blob is not None
    return FileResponse(item.blob, media_type=item.mime_type)


@router.get("/sites/{site}/drive/root/permissions")
@router.get("/sites/{site}/drive/items/{item_id}/permissions")
async def list_permissions(drive: SiteDep, ref: RefDep) -> JSON:
    """Effective permissions, the root-most first; inherited ones carry `inheritedFrom`."""
    item = drive.get(ref)
    return {"value": [permission(drive, item, e) for e in drive.effective(item)]}


DELTA_TOKEN = re.compile(r"([0-9a-f]*-\d+)\.([01])\.(\d+)\.(-1|\d+)\.(\d+)")


@dataclass(frozen=True)
class Round:
    """A delta position: changes in (start, end], or with `full` every item that existed at `end`,
    of which `offset` were already sent. A deltaLink leaves `end` open (-1) until it's used."""

    full: bool
    start: int
    end: int
    offset: int = 0

    def link(self, request: Request, site: str, generation: str) -> str:
        token = _encode(site, generation, int(self.full), self.start, self.end, self.offset)
        return _link(request, token=token)


def _round(request: Request, drive: Site, generation: str, token: str | None) -> Round:
    if token is None:
        return Round(full=True, start=0, end=drive.seq)
    site, _, rest = _decode(token).partition(".")
    match = DELTA_TOKEN.fullmatch(rest)
    if site != drive.name or match is None:
        raise bad_request("Invalid delta token.")
    full, start, end, offset = (int(g) for g in match.groups()[1:])
    if match[1] != generation or max(start, end) > drive.seq:
        raise GraphError(
            410,
            "resyncRequired",
            "Resync required: the token is no longer valid. Enumerate again from the Location.",
            {"Location": _link(request, token=None)},
            inner_code="resyncChangesApplyDifferences",
        )
    return Round(bool(full), start, drive.seq if end == -1 else end, offset)


def _delta_entry(drive: Site, item: Item, shared: bool) -> JSON:
    if item.deleted_seq is not None:
        parent = {"id": item.parent_id}
        return {"id": item.id, "deleted": {"state": "deleted"}, "parentReference": parent}
    body = drive_item(drive, item, delta=True)
    if shared:
        body["@microsoft.graph.sharedChanged"] = "True"
    return body


@router.get("/sites/{site}/drive/root/delta")
async def delta(
    request: Request,
    rt: RuntimeDep,
    drive: SiteDep,
    token: str | None = None,
    top: Top = DEFAULT_PAGE,
) -> JSON:
    """Changes since `token`, or every item without one, one page at a time. Items appear once,
    in their current state, in the order they first changed (or were created)."""
    generation = rt.workspace.generation
    if token == "latest":
        return {
            "value": [],
            "@odata.deltaLink": Round(False, drive.seq, -1).link(request, drive.name, generation),
        }
    at = _round(request, drive, generation, token)
    prefer = ",".join(request.headers.getlist("prefer")).lower().split(",")
    sharing = "deltashowsharingchanges" in (p.strip() for p in prefer)
    if at.full:
        entries = [(item, False) for item in drive.existing(at.end)]
    else:
        entries = drive.changed(at.start, at.end, sharing=sharing)
    top = min(top, MAX_PAGE)
    page = entries[at.offset : at.offset + top]
    body: JSON = {"value": [_delta_entry(drive, item, shared and sharing) for item, shared in page]}
    if at.offset + top < len(entries):
        next_round = Round(at.full, at.start, at.end, at.offset + top)
        body["@odata.nextLink"] = next_round.link(request, drive.name, generation)
    else:
        body["@odata.deltaLink"] = Round(False, at.end, -1).link(request, drive.name, generation)
    return body


@router.post("/subscriptions", status_code=201)
async def create_subscription(
    body: SubscriptionRequest, rt: RuntimeDep, site: Annotated[str, Depends(subscriber)]
) -> JSON:
    return (await rt.notifier.subscribe(site, body)).graph()


@router.patch("/subscriptions/{subscription_id}")
async def renew_subscription(
    subscription_id: str,
    body: SubscriptionRenewal,
    rt: RuntimeDep,
    site: Annotated[str, Depends(subscriber)],
) -> JSON:
    return rt.notifier.renew(site, subscription_id, body.expiration).graph()


@router.delete("/subscriptions/{subscription_id}", status_code=204)
async def delete_subscription(
    subscription_id: str, rt: RuntimeDep, site: Annotated[str, Depends(subscriber)]
) -> Response:
    rt.notifier.remove(site, subscription_id)
    return Response(status_code=204)
