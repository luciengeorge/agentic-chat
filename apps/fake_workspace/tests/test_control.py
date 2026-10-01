import base64
from pathlib import Path
from typing import Any

import httpx
import pytest

from ac_fake_workspace.testing import Corpus, MakeClient, Receiver, build_corpus

CONTROL = "/_control/sites/kestrel/items"
SITE = "/v1.0/sites/kestrel/drive"


async def snapshot(client: httpx.AsyncClient) -> list[Any]:
    """Every item, its children and its permissions, walked from the root."""
    seen: list[Any] = []
    queue = ["root"]
    while queue:
        item_id = queue.pop(0)
        item = (await client.get(f"{SITE}/items/{item_id}")).json()
        children = (await client.get(f"{SITE}/items/{item_id}/children?$top=200")).json()
        permissions = (await client.get(f"{SITE}/items/{item_id}/permissions")).json()
        seen.append([item, permissions])
        queue.extend(child["id"] for child in children["value"])
    return seen


async def test_control_api_is_dev_only(make_client: MakeClient) -> None:
    client = make_client(env="test")
    for method, path in (("POST", "/_control/reset"), ("GET", "/_control/deliveries")):
        response = await client.request(method, path)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "accessDenied"
    assert (await client.get(f"{SITE}/root")).status_code == 200


async def test_reset_restores_the_manifest(
    client: httpx.AsyncClient, corpus: Corpus, receiver: Receiver
) -> None:
    before = await snapshot(client)
    await client.post("/_control/clock", json={"now": "2026-10-01T12:00:00Z"})
    subscription = {
        "changeType": "updated",
        "notificationUrl": receiver.url,
        "resource": "sites/kestrel/drive/root",
        "expirationDateTime": "2026-10-02T12:00:00Z",
        "clientState": "s",
    }
    assert (await client.post("/v1.0/subscriptions", json=subscription)).status_code == 201
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    await client.post(f"{CONTROL}/{memo}/rename", json={"name": "Heron.pdf"})
    await client.delete(f"{CONTROL}/{corpus.id('kestrel', '/HR')}")
    created = await client.post(
        CONTROL,
        json={"parent_id": "root", "name": "x.md", "content_base64": "", "mime_type": "text/plain"},
    )
    await client.post("/_control/faults", json={"kind": "throttle", "after_requests": 100})
    await client.post("/_control/flush")
    assert (await client.get("/_control/deliveries")).json()["value"]

    response = await client.post("/_control/reset")
    assert response.status_code == 200
    assert response.json() == {"corpus_loaded": True, "sites": {"harbour": 3, "kestrel": 17}}
    assert await snapshot(client) == before
    assert (await client.get(f"{SITE}/items/{created.json()['id']}")).status_code == 404
    assert (await client.get("/_control/deliveries")).json()["value"] == []
    await client.post(f"{CONTROL}/{memo}/rename", json={"name": "Heron.pdf"})
    await client.post("/_control/flush")
    assert (await client.get("/_control/deliveries")).json()["value"] == []
    for _ in range(3):
        assert (await client.get(f"{SITE}/root")).status_code == 200
    # The clock is unpinned again: new timestamps come from the real clock.
    renamed = (await client.get(f"{SITE}/items/{memo}")).json()
    assert not renamed["lastModifiedDateTime"].startswith("2026-10-01T12:00")


async def test_reset_loads_a_corpus_built_after_start(
    make_client: MakeClient, tmp_path: Path
) -> None:
    client = make_client(corpus_dir=tmp_path / "later")
    assert (await client.get(f"{SITE}/root")).status_code == 503
    failed = await client.post("/_control/reset")
    assert failed.status_code == 503
    assert "manifest.json" in failed.json()["error"]["message"]
    build_corpus(tmp_path / "later")
    assert (await client.post("/_control/reset")).status_code == 200
    assert (await client.get(f"{SITE}/root")).status_code == 200
    assert (await client.get("/health")).json()["corpus_loaded"] is True


async def test_broken_manifest_is_reported(make_client: MakeClient, tmp_path: Path) -> None:
    corpus = build_corpus(tmp_path / "broken")
    manifest = corpus.dir / "manifest.json"
    manifest.write_text(manifest.read_text().replace('"parent_id": null', '"parent_id": "nope"'))
    client = make_client(corpus_dir=corpus.dir)
    response = await client.post("/_control/reset")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "serviceNotReady"


async def test_a_site_groups_grant_is_accepted(client: httpx.AsyncClient, corpus: Corpus) -> None:
    hr = corpus.id("kestrel", "/HR")
    body = group(corpus.group("kestrel", "/Kestrel/Exec"), "/Kestrel/Exec")
    assert (await client.put(f"{CONTROL}/{hr}/sharing", json=body)).status_code == 200
    permissions = (await client.get(f"{SITE}/items/{hr}/permissions")).json()["value"]
    assert [p["grantedToV2"]["group"]["displayName"] for p in permissions] == ["/Kestrel/Exec"]


@pytest.mark.parametrize(
    ("before", "after", "problem"),
    [
        # A grant to a group the site doesn't list.
        ('"path": "/Kestrel/HR"', '"path": "/Kestrel/People"', "/Kestrel/HR"),
        # No groups at all: the manifest's schema requires them.
        ('"groups": {', '"teams": {', "groups"),
    ],
    ids=["unknown group", "no groups"],
)
async def test_a_manifest_must_list_the_groups_it_grants_to(
    make_client: MakeClient, tmp_path: Path, before: str, after: str, problem: str
) -> None:
    corpus = build_corpus(tmp_path / "corpus")
    manifest = corpus.dir / "manifest.json"
    text = manifest.read_text()
    assert before in text
    manifest.write_text(text.replace(before, after))
    client = make_client(corpus_dir=corpus.dir)
    assert (await client.get("/health")).json()["corpus_loaded"] is False
    response = await client.post("/_control/reset")
    assert response.status_code == 503
    assert problem in response.json()["error"]["message"]


async def test_clock_pins_timestamps(client: httpx.AsyncClient) -> None:
    pinned = await client.post("/_control/clock", json={"now": "2026-10-01T12:00:00+01:00"})
    assert pinned.json() == {"now": "2026-10-01T11:00:00Z", "pinned": True}
    body = {"parent_id": "root", "name": "x.md", "content_base64": "", "mime_type": "text/plain"}
    created = (await client.post(CONTROL, json=body)).json()
    assert created["createdDateTime"] == "2026-10-01T11:00:00Z"
    assert created["lastModifiedDateTime"] == "2026-10-01T11:00:00Z"
    assert set(created["createdBy"]) == {"application"}
    unpinned = (await client.post("/_control/clock", json={"now": None})).json()
    assert unpinned["pinned"] is False
    assert unpinned["now"] != "2026-10-01T11:00:00Z"


async def test_create_file(client: httpx.AsyncClient, corpus: Corpus) -> None:
    body = {
        "parent_id": corpus.id("kestrel", "/Company"),
        "name": "Rota.md",
        "content_base64": base64.b64encode(b"# rota").decode(),
        "mime_type": "text/markdown",
    }
    response = await client.post(CONTROL, json=body)
    assert response.status_code == 201
    item = response.json()
    assert item["file"]["mimeType"] == "text/markdown"
    assert item["parentReference"] == {
        "id": corpus.id("kestrel", "/Company"),
        "path": "/drive/root:/Company",
    }
    assert (await client.get(f"{SITE}/items/{item['id']}/content")).content == b"# rota"
    permissions = (await client.get(f"{SITE}/items/{item['id']}/permissions")).json()["value"]
    assert [p["inheritedFrom"]["id"] for p in permissions] == [corpus.id("kestrel", "/Company")]


NEW_FILE = {"parent_id": "root", "name": "x", "content_base64": "", "mime_type": "text/plain"}
STRANGER = {"principal_type": "user", "principal_id": "x", "principal_name": "x", "role": "read"}


def group(group_id: str, name: str) -> dict[str, object]:
    sharing = {"principal_type": "group", "principal_id": group_id, "principal_name": name}
    return {"inherit": True, "grants": [{**sharing, "role": "read"}]}


@pytest.mark.parametrize(
    ("method", "path", "body", "status", "code"),
    [
        ("POST", "/{note}/move", {"parent_id": "{casework}/x"}, 404, "itemNotFound"),
        ("POST", "/{hr}/move", {"parent_id": "{casework}"}, 400, "invalidRequest"),
        ("POST", "/{hr}/move", {"parent_id": "{note}"}, 400, "invalidRequest"),
        ("POST", "/{note}/move", {"parent_id": "{casework}", "name": "a/b"}, 400, "invalidRequest"),
        ("POST", "/{hr}/rename", {"name": "COMPANY"}, 409, "nameAlreadyExists"),
        ("POST", "/root/rename", {"name": "x"}, 400, "invalidRequest"),
        ("POST", "/root/move", {"parent_id": "{hr}"}, 400, "invalidRequest"),
        ("DELETE", "/root", None, 400, "invalidRequest"),
        ("DELETE", "/nope", None, 404, "itemNotFound"),
        ("PUT", "/{hr}/content", {"content_base64": "eA=="}, 400, "invalidRequest"),
        ("PUT", "/{note}/content", {"content_base64": "%%%"}, 400, "invalidRequest"),
        ("POST", "", {**NEW_FILE, "parent_id": "{note}"}, 400, "invalidRequest"),
        ("POST", "", {**NEW_FILE, "name": "hr"}, 409, "nameAlreadyExists"),
        ("PUT", "/{hr}/sharing", {"inherit": True, "grants": [STRANGER]}, 400, "invalidRequest"),
        ("PUT", "/{hr}/sharing", group("nope", "/Kestrel/HR"), 400, "invalidRequest"),
        # Harbour's group, id and name both right, on a Kestrel item.
        ("PUT", "/{hr}/sharing", group("{harbour}", "/Harbour"), 400, "invalidRequest"),
        # A Kestrel group's id under another group's name.
        ("PUT", "/{hr}/sharing", group("{exec}", "/Kestrel/HR"), 400, "invalidRequest"),
    ],
)
async def test_invalid_mutations(
    client: httpx.AsyncClient,
    corpus: Corpus,
    method: str,
    path: str,
    body: Any,
    status: int,
    code: str,
) -> None:
    ids = {
        "hr": corpus.id("kestrel", "/HR"),
        "casework": corpus.id("kestrel", "/HR/Casework"),
        "note": corpus.id("kestrel", "/HR/Casework/case note.pdf"),
        "exec": corpus.group("kestrel", "/Kestrel/Exec"),
        "harbour": corpus.group("harbour", "/Harbour"),
    }

    def fill(value: Any) -> Any:
        if isinstance(value, str):
            return value.format(**ids)
        if isinstance(value, dict):
            return {k: fill(v) for k, v in value.items()}  # pyright: ignore[reportUnknownVariableType]
        if isinstance(value, list):
            return [fill(v) for v in value]  # pyright: ignore[reportUnknownVariableType]
        return value

    response = await client.request(method, CONTROL + fill(path), json=fill(body))
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


async def test_unknown_site_is_404(client: httpx.AsyncClient) -> None:
    response = await client.delete("/_control/sites/nowhere/items/root")
    assert response.status_code == 404
