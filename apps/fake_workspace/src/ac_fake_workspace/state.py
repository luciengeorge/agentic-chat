"""The drives, in memory: items from the manifest, their sharing, and a change log per site."""

import asyncio
import hashlib
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from pydantic import AwareDatetime, BaseModel, ConfigDict, ValidationError

from ac_fake_workspace.errors import GraphError, bad_request, not_found

# For the ids fake-workspace makes itself: new items, permissions, subscriptions, tenants.
NAMESPACE = uuid.UUID("8f1d3a52-6c7e-4b1a-9d2f-3e5c7a9b0d14")
TOKEN_PREFIX = "dev-workspace-"
INVALID_NAME_CHARS = set('"*:<>?/\\|')

type Acl = frozenset[tuple[str, str, str, str | None]]  # type, principal, role, inherited from


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


class Clock:
    """Real UTC time, unless the control API pinned it. Waits (retry backoff, injected latency)
    go through `sleep`, so tests can see and control them."""

    def __init__(self) -> None:
        self.pinned: datetime | None = None

    def now(self) -> datetime:
        return self.pinned or datetime.now(UTC)

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class Grant(BaseModel):
    model_config = ConfigDict(frozen=True)

    principal_type: Literal["user", "group"]
    principal_id: str
    principal_name: str
    role: Literal["read", "write"]


class Sharing(BaseModel):
    model_config = ConfigDict(frozen=True)

    inherit: bool = True
    grants: tuple[Grant, ...] = ()


class ManifestFile(BaseModel):
    mime_type: str
    size: int
    sha256: str
    blob: str


class ManifestItem(BaseModel):
    id: str
    path: str
    name: str
    parent_id: str | None
    kind: Literal["folder", "file"]
    created: AwareDatetime
    modified: AwareDatetime
    created_by: str | None
    modified_by: str | None
    file: ManifestFile | None = None
    sharing: Sharing


class ManifestUser(BaseModel):
    username: str
    display_name: str


class ManifestGroup(BaseModel):
    path: str


class ManifestSite(BaseModel):
    items: list[ManifestItem]
    users: dict[str, ManifestUser]
    groups: dict[str, ManifestGroup]


class Manifest(BaseModel):
    version: Literal[1]
    sites: dict[str, ManifestSite]


@dataclass(eq=False)
class Item:
    id: str
    name: str
    parent_id: str | None
    folder: bool
    created: datetime
    modified: datetime
    created_by: str | None  # a user id; None when the control API made the change
    modified_by: str | None
    sharing: Sharing
    created_seq: int = 0
    deleted_seq: int | None = None
    version: int = 1  # eTag: any change to the item, its effective sharing included
    content_version: int = 1  # cTag: content only
    mime_type: str | None = None
    size: int = 0
    sha256: str | None = None
    blob: Path | None = None
    content: bytes | None = None  # uploaded through the control API; otherwise the blob is served

    @property
    def etag(self) -> str:
        return f'"{{{self.id.upper()}}},{self.version}"'

    @property
    def ctag(self) -> str:
        return f'"c:{{{self.id.upper()}}},{self.content_version}"'

    def store(self, content: bytes, mime_type: str | None) -> None:
        self.content = content
        self.size = len(content)
        self.sha256 = hashlib.sha256(content).hexdigest()
        if mime_type is not None:
            self.mime_type = mime_type


@dataclass(frozen=True)
class Change:
    item_id: str
    sharing: bool  # only the item's effective sharing changed


@dataclass(frozen=True)
class Effective:
    grant: Grant
    source: Item | None  # the ancestor it's inherited from; None when it's the item's own


class CorpusError(Exception):
    pass


def sort_key(item: Item) -> tuple[str, str]:
    """How children are listed: by name, case-insensitively, then by id."""
    return item.name.casefold(), item.id


class Site:
    """One tenant's drive. Deleted items stay as tombstones so delta can report them."""

    def __init__(self, name: str, users: dict[str, str], groups: dict[str, str]) -> None:
        self.name = name
        self.users = users  # user id -> display name
        self.groups = groups  # group id -> path
        self.items: dict[str, Item] = {}  # in creation order
        self.changes: list[Change] = []  # change n has seq n + 1
        self.history = [""]  # history[n]: a digest of the first n changes and what they left
        self.root_id = ""
        self._created = 0

    @property
    def seq(self) -> int:
        return len(self.changes)

    def get(self, ref: str) -> Item:
        item = self.items.get(self.root_id if ref == "root" else ref)
        if item is None or item.deleted_seq is not None:
            raise not_found()
        return item

    def children(self, item: Item) -> list[Item]:
        live = (i for i in self.items.values() if i.parent_id == item.id and i.deleted_seq is None)
        return sorted(live, key=sort_key)

    def descendants(self, item: Item) -> list[Item]:
        """Depth first, each folder before its contents."""
        found: list[Item] = []
        for child in self.children(item):
            found += [child, *self.descendants(child)]
        return found

    def path(self, item: Item) -> str:
        names: list[str] = []
        while item.parent_id is not None:
            names.append(item.name)
            item = self.items[item.parent_id]
        return "/" + "/".join(reversed(names))

    def drive_path(self, item: Item) -> str:
        """Graph's percent-encoded API path, e.g. `/drive/root:/Finance/FP%26A`."""
        return "/drive/root:" + ("" if item.parent_id is None else quote(self.path(item)))

    def size(self, item: Item) -> int:
        if not item.folder:
            return item.size
        return sum(d.size for d in self.descendants(item) if not d.folder)

    def strangers(self, grants: Iterable[Grant]) -> list[Grant]:
        """The grants that name no user or group of this site. A group grant's name must be that
        group's path too, since permissions show it as the group's displayName."""
        return [
            g
            for g in grants
            if (
                g.principal_id not in self.users
                if g.principal_type == "user"
                else self.groups.get(g.principal_id) != g.principal_name
            )
        ]

    def effective(self, item: Item) -> list[Effective]:
        """Own grants plus, while `inherit` holds, the parent's effective ones. The stronger role
        wins when a principal appears twice."""
        chain = [item]
        while chain[-1].sharing.inherit and chain[-1].parent_id is not None:
            chain.append(self.items[chain[-1].parent_id])
        result: dict[tuple[str, str], Effective] = {}
        for node in reversed(chain):
            for grant in node.sharing.grants:
                key = (grant.principal_type, grant.principal_id)
                held = result.get(key)
                if held is None or (grant.role == "write" and held.grant.role == "read"):
                    result[key] = Effective(grant, None if node is item else node)
        return list(result.values())

    def changed(self, start: int, end: int, *, sharing: bool) -> list[tuple[Item, bool]]:
        """Items changed in (start, end], once each in order of first change, with whether their
        sharing changed. Items whose only change is sharing count only when `sharing` is set."""
        flags: dict[str, tuple[bool, bool]] = {}
        for change in self.changes[start:end]:
            other, shared = flags.get(change.item_id, (False, False))
            flags[change.item_id] = (other or not change.sharing, shared or change.sharing)
        return [
            (self.items[item_id], shared)
            for item_id, (other, shared) in flags.items()
            if other or (shared and sharing)
        ]

    def existing(self, end: int) -> list[Item]:
        """Every item that existed after change `end`, in creation order: parents first unless a
        folder moved under a newer one. A tree walk always would be, but a move during the round
        would shift its offsets and skip an item."""
        return [
            i
            for i in self.items.values()
            if i.created_seq <= end and (i.deleted_seq is None or i.deleted_seq > end)
        ]

    # Mutations. Each records its changes; the caller sends the notifications.

    def create_file(
        self, parent_ref: str, name: str, content: bytes, mime_type: str, now: datetime
    ) -> Item:
        parent = self._folder(parent_ref)
        self._check_name(parent, name)
        self._created += 1
        path = f"{self.path(parent).rstrip('/')}/{name}"
        item = Item(
            id=str(uuid.uuid5(NAMESPACE, f"{self.name}:{path}:{self._created}")),
            name=name,
            parent_id=parent.id,
            folder=False,
            created=now,
            modified=now,
            created_by=None,
            modified_by=None,
            sharing=Sharing(),
            created_seq=self.seq + 1,
        )
        item.store(content, mime_type)
        self.items[item.id] = item
        self._record(item)
        return item

    def upload(self, ref: str, content: bytes, mime_type: str | None, now: datetime) -> Item:
        item = self.get(ref)
        if item.folder:
            raise bad_request("A folder has no content.")
        item.store(content, mime_type)
        item.content_version += 1
        self._touch(item, now)
        return item

    def rename(self, ref: str, name: str, now: datetime) -> Item:
        item = self._movable(ref)
        assert item.parent_id is not None
        self._check_name(self.items[item.parent_id], name, moving=item)
        item.name = name
        self._touch(item, now)
        return item

    def move(self, ref: str, parent_ref: str, name: str | None, now: datetime) -> Item:
        item = self._movable(ref)
        parent = self._folder(parent_ref)
        if parent is item or parent.id in {d.id for d in self.descendants(item)}:
            raise bad_request("A folder can't move into itself.")
        name = item.name if name is None else name
        self._check_name(parent, name, moving=item)
        before = self._acls(item)
        item.parent_id = parent.id
        item.name = name
        self._touch(item, now)
        self._record_acl_changes(before)
        return item

    def delete(self, ref: str) -> None:
        item = self._movable(ref)
        for doomed in self._bottom_up(item):
            doomed.deleted_seq = self.seq + 1
            self._record(doomed)

    def set_sharing(self, ref: str, sharing: Sharing) -> Item:
        item = self.get(ref)
        if strangers := self.strangers(sharing.grants):
            names = ", ".join(
                f"{g.principal_type} {g.principal_name} ({g.principal_id})" for g in strangers
            )
            raise bad_request(f"Not a user or group of this site: {names}.")
        before = self._acls(item)
        del before[item.id]
        item.sharing = sharing
        item.version += 1
        self._record(item, sharing=True)
        self._record_acl_changes(before)
        return item

    def _record(self, item: Item, *, sharing: bool = False) -> None:
        self.changes.append(Change(item.id, sharing))
        state = (
            item.id,
            sharing,
            item.name,
            item.parent_id,
            item.deleted_seq is not None,
            item.version,
            item.sha256,
            iso(item.modified),
            item.sharing.model_dump_json(),
        )
        digest = hashlib.sha256(f"{self.history[-1]}{state!r}".encode()).hexdigest()
        self.history.append(digest[:16])

    def _touch(self, item: Item, now: datetime) -> None:
        item.version += 1
        item.modified = now
        item.modified_by = None
        self._record(item)

    def _acl(self, item: Item) -> Acl:
        """What the item's permissions show, so a grant that moves to another ancestor (its
        `inheritedFrom`) counts as a sharing change too."""
        return frozenset(
            (
                e.grant.principal_type,
                e.grant.principal_id,
                e.grant.role,
                None if e.source is None else e.source.id,
            )
            for e in self.effective(item)
        )

    def _acls(self, item: Item) -> dict[str, Acl]:
        return {i.id: self._acl(i) for i in (item, *self.descendants(item))}

    def _record_acl_changes(self, before: dict[str, Acl]) -> None:
        """A sharing change for every item whose effective sharing changed, with a new eTag, so a
        connector that skips unchanged eTags still sees a revoked grant."""
        for item_id, acl in before.items():
            item = self.items[item_id]
            if self._acl(item) != acl:
                item.version += 1
                self._record(item, sharing=True)

    def _bottom_up(self, item: Item) -> list[Item]:
        found: list[Item] = []
        for child in self.children(item):
            found += self._bottom_up(child)
        return [*found, item]

    def _folder(self, ref: str) -> Item:
        item = self.get(ref)
        if not item.folder:
            raise bad_request("The parent must be a folder.")
        return item

    def _movable(self, ref: str) -> Item:
        item = self.get(ref)
        if item.parent_id is None:
            raise bad_request("The root can't be moved, renamed or deleted.")
        return item

    def _check_name(self, parent: Item, name: str, moving: Item | None = None) -> None:
        if not name.strip() or INVALID_NAME_CHARS & set(name):
            raise bad_request(f"{name!r} isn't a valid name.")
        if any(
            c.name.casefold() == name.casefold() for c in self.children(parent) if c is not moving
        ):
            raise GraphError(409, "nameAlreadyExists", f"{name!r} already exists in this folder.")


class Workspace:
    """Every site in the corpus. Reloading replaces them all."""

    def __init__(self, corpus_dir: Path) -> None:
        self.corpus_dir = corpus_dir
        self.sites: dict[str, Site] = {}
        self.loaded = False
        self.resets = 0
        self.digest = ""

    @property
    def generation(self) -> str:
        """Which corpus and which reset delta tokens belong to; tokens from another are refused.
        It's deterministic, so a restart on the same corpus accepts tokens from before as long as
        its change log repeats theirs (each token carries the log's digest)."""
        return f"{self.digest[:12]}-{self.resets}"

    def load(self) -> None:
        self.sites, self.loaded = {}, False
        self.sites, self.digest = load_corpus(self.corpus_dir)
        self.loaded = True

    def reset(self) -> None:
        self.resets += 1
        self.load()

    def site_for_token(self, token: str) -> str | None:
        site = token.removeprefix(TOKEN_PREFIX)
        return site if token.startswith(TOKEN_PREFIX) and site in self.sites else None


def load_corpus(corpus_dir: Path) -> tuple[dict[str, Site], str]:
    """The sites in `manifest.json`, and the manifest's sha256."""
    path = corpus_dir / "manifest.json"
    try:
        raw = path.read_bytes()
        manifest = Manifest.model_validate_json(raw)
    except OSError as e:
        raise CorpusError(f"can't read {path}: {e.strerror}") from e
    except ValidationError as e:
        raise CorpusError(f"{path} doesn't match the manifest schema: {e}") from e
    sites = {name: _load_site(name, site, corpus_dir) for name, site in manifest.sites.items()}
    return sites, hashlib.sha256(raw).hexdigest()


def _load_site(name: str, data: ManifestSite, corpus_dir: Path) -> Site:
    users = {user_id: user.display_name for user_id, user in data.users.items()}
    site = Site(name, users, {group_id: group.path for group_id, group in data.groups.items()})
    for entry in data.items:
        item = _load_item(site, entry, corpus_dir)
        site.items[item.id] = item
        if item.parent_id is None:
            site.root_id = item.id
    if not site.root_id:
        raise CorpusError(f"{name}: no root folder")
    return site


def _load_item(site: Site, entry: ManifestItem, corpus_dir: Path) -> Item:
    def fail(problem: str) -> CorpusError:
        return CorpusError(f"{site.name}: {entry.path}: {problem}")

    if entry.id in site.items:
        raise fail("duplicate id")
    users = [entry.created_by, entry.modified_by]
    if unknown := [u for u in users if u is not None and u not in site.users]:
        raise fail(f"unknown users {unknown}")
    if strangers := site.strangers(entry.sharing.grants):
        raise fail(
            f"grants to principals the site doesn't have: {[g.principal_name for g in strangers]}"
        )
    item = Item(
        id=entry.id,
        name=entry.name,
        parent_id=entry.parent_id,
        folder=entry.kind == "folder",
        created=entry.created,
        modified=entry.modified,
        created_by=entry.created_by,
        modified_by=entry.modified_by,
        sharing=entry.sharing,
    )
    if entry.parent_id is None:
        if site.items or entry.path != "/" or not item.folder:
            raise fail("the root must be the first item, a folder at /")
    else:
        parent = site.items.get(entry.parent_id)
        if parent is None or not parent.folder:
            raise fail("its parent must be an earlier folder")
        if site.path(parent).rstrip("/") + "/" + entry.name != entry.path:
            raise fail("its path doesn't match its parent's path and its name")
        if any(c.name.casefold() == entry.name.casefold() for c in site.children(parent)):
            raise fail("a sibling has the same name")
    if (entry.file is None) != item.folder:
        raise fail("files, and only files, have a `file`")
    if entry.file is not None:
        blob = corpus_dir / entry.file.blob
        if not blob.resolve().is_relative_to(corpus_dir.resolve()) or not blob.is_file():
            raise fail(f"blob {entry.file.blob} is missing")
        item.mime_type, item.size = entry.file.mime_type, entry.file.size
        item.sha256, item.blob = entry.file.sha256, blob
    return item
