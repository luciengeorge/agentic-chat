"""The control API (`/_control/...`): dev only, no bearer token. Tests and the lab panel use it to
reset state, inject faults, pin the clock, change items and watch webhook deliveries."""

import base64
import binascii
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import AwareDatetime, BaseModel, PlainValidator

from ac_fake_workspace.errors import GraphError, not_found
from ac_fake_workspace.faults import FaultSpec
from ac_fake_workspace.routes import JSON, Runtime, RuntimeDep, drive_item
from ac_fake_workspace.state import CorpusError, Sharing, Site, iso


async def dev_only(rt: RuntimeDep) -> None:
    if rt.env != "dev":
        raise GraphError(403, "accessDenied", "The control API only runs when AC_ENV=dev.")


router = APIRouter(prefix="/_control", dependencies=[Depends(dev_only)])


def _base64(value: object) -> bytes:
    if not isinstance(value, str):
        raise ValueError("expected a base64 string")
    try:
        return base64.b64decode(value, validate=True)
    except binascii.Error as e:
        raise ValueError("not valid base64") from e


Base64Bytes = Annotated[bytes, PlainValidator(_base64)]


class NewFile(BaseModel):
    parent_id: str
    name: str
    content_base64: Base64Bytes
    mime_type: str


class Upload(BaseModel):
    content_base64: Base64Bytes
    mime_type: str | None = None


class Move(BaseModel):
    parent_id: str
    name: str | None = None


class Rename(BaseModel):
    name: str


class ClockSetting(BaseModel):
    now: AwareDatetime | None


async def control_site(site: str, rt: RuntimeDep) -> Site:
    if not rt.workspace.loaded:
        raise GraphError(503, "serviceNotReady", "No corpus is loaded yet.")
    if site not in rt.workspace.sites:
        raise not_found(f"No site {site!r}.")
    return rt.workspace.sites[site]


SiteDep = Annotated[Site, Depends(control_site)]


def changed(rt: Runtime, site: Site) -> None:
    rt.notifier.changed(site.name, site.seq)


@router.post("/reset")
async def reset(rt: RuntimeDep) -> JSON:
    """Reload the manifest; drop faults, subscriptions, deliveries, the change log and the clock."""
    await rt.notifier.reset()
    rt.faults.clear()
    rt.clock.pinned = None
    try:
        rt.workspace.reset()
    except CorpusError as e:
        raise GraphError(503, "serviceNotReady", str(e)) from e
    sites = {name: len(site.items) for name, site in rt.workspace.sites.items()}
    return {"corpus_loaded": True, "sites": sites}


@router.post("/faults", status_code=201)
async def add_fault(spec: FaultSpec, rt: RuntimeDep) -> FaultSpec:
    rt.faults.add(spec)
    return spec


@router.delete("/faults", status_code=204)
async def clear_faults(rt: RuntimeDep) -> Response:
    rt.faults.clear()
    return Response(status_code=204)


@router.post("/clock")
async def set_clock(setting: ClockSetting, rt: RuntimeDep) -> JSON:
    rt.clock.pinned = setting.now
    return {"now": iso(rt.clock.now()), "pinned": setting.now is not None}


@router.get("/deliveries")
async def list_deliveries(rt: RuntimeDep) -> JSON:
    return {"value": [d.graph() for d in rt.notifier.deliveries]}


@router.post("/flush")
async def flush(rt: RuntimeDep) -> JSON:
    """Wait for every pending delivery, retries included, then return the log."""
    await rt.notifier.flush()
    return {"value": [d.graph() for d in rt.notifier.deliveries]}


def _now(rt: Runtime) -> datetime:
    return rt.clock.now().replace(microsecond=0)


@router.post("/sites/{site}/items", status_code=201)
async def create_file(body: NewFile, drive: SiteDep, rt: RuntimeDep) -> JSON:
    item = drive.create_file(
        body.parent_id, body.name, body.content_base64, body.mime_type, _now(rt)
    )
    changed(rt, drive)
    return drive_item(drive, item)


@router.put("/sites/{site}/items/{item_id}/content")
async def upload(item_id: str, body: Upload, drive: SiteDep, rt: RuntimeDep) -> JSON:
    item = drive.upload(item_id, body.content_base64, body.mime_type, _now(rt))
    changed(rt, drive)
    return drive_item(drive, item)


@router.post("/sites/{site}/items/{item_id}/move")
async def move(item_id: str, body: Move, drive: SiteDep, rt: RuntimeDep) -> JSON:
    item = drive.move(item_id, body.parent_id, body.name, _now(rt))
    changed(rt, drive)
    return drive_item(drive, item)


@router.post("/sites/{site}/items/{item_id}/rename")
async def rename(item_id: str, body: Rename, drive: SiteDep, rt: RuntimeDep) -> JSON:
    item = drive.rename(item_id, body.name, _now(rt))
    changed(rt, drive)
    return drive_item(drive, item)


@router.delete("/sites/{site}/items/{item_id}", status_code=204)
async def delete(item_id: str, drive: SiteDep, rt: RuntimeDep) -> Response:
    drive.delete(item_id)
    changed(rt, drive)
    return Response(status_code=204)


@router.put("/sites/{site}/items/{item_id}/sharing")
async def set_sharing(item_id: str, body: Sharing, drive: SiteDep, rt: RuntimeDep) -> JSON:
    item = drive.set_sharing(item_id, body)
    changed(rt, drive)
    return drive_item(drive, item)
