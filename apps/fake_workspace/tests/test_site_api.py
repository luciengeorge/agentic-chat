import base64
import hashlib
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from ac_fake_workspace.testing import Corpus, MakeClient

SITE = "/v1.0/sites/kestrel/drive"


def item_url(item_id: str, suffix: str = "") -> str:
    return f"{SITE}/items/{item_id}{suffix}"


@pytest.mark.parametrize("token", [None, "nope"])
async def test_missing_or_unknown_token_is_401(make_client: MakeClient, token: str | None) -> None:
    response = await make_client(token=token).get(f"{SITE}/root")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "InvalidAuthenticationToken"


async def test_non_bearer_scheme_is_401(client: httpx.AsyncClient) -> None:
    headers = {"Authorization": "Basic dev-workspace-kestrel"}
    assert (await client.get(f"{SITE}/root", headers=headers)).status_code == 401


@pytest.mark.parametrize(
    ("token", "path"),
    [
        ("dev-workspace-harbour", f"{SITE}/root"),
        ("dev-workspace-harbour", f"{SITE}/root/delta"),
        ("dev-workspace-kestrel", "/v1.0/sites/harbour/drive/root"),
        ("dev-workspace-kestrel", "/v1.0/sites/nowhere/drive/root"),
    ],
)
async def test_token_for_another_site_is_403(
    make_client: MakeClient, token: str, path: str
) -> None:
    response = await make_client(token=token).get(path)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "accessDenied"


async def test_each_token_opens_its_own_site(make_client: MakeClient) -> None:
    harbour = make_client(token="dev-workspace-harbour")
    assert (await harbour.get("/v1.0/sites/harbour/drive/root")).status_code == 200


async def test_root(client: httpx.AsyncClient, corpus: Corpus) -> None:
    root = (await client.get(f"{SITE}/root")).json()
    assert root["id"] == corpus.id("kestrel", "/")
    assert root["root"] == {}
    assert root["folder"] == {"childCount": 4}
    assert "parentReference" not in root
    assert "cTag" not in root
    # As in the real build, the tenant's first enabled admin made the root.
    amara = {"user": {"id": corpus.user("kestrel", "amara.okafor"), "displayName": "Amara Okafor"}}
    assert (root["createdBy"], root["lastModifiedBy"]) == (amara, amara)
    assert (await client.get(item_url("root"))).json() == root


async def test_file_item(client: httpx.AsyncClient, corpus: Corpus) -> None:
    item_id = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    item = (await client.get(item_url(item_id))).json()
    content = corpus.content("kestrel", "/Finance/Reports/Q3 report.pdf")
    tom = {"user": {"id": corpus.user("kestrel", "tom.whitfield"), "displayName": "Tom Whitfield"}}
    assert item == {
        "id": item_id,
        "name": "Q3 report.pdf",
        "eTag": f'"{{{item_id.upper()}}},1"',
        "cTag": f'"c:{{{item_id.upper()}}},1"',
        "createdDateTime": "2026-09-01T09:00:00Z",
        "lastModifiedDateTime": "2026-09-02T10:30:00Z",
        "size": len(content),
        "createdBy": tom,
        "lastModifiedBy": tom,
        "parentReference": {
            "id": corpus.id("kestrel", "/Finance/Reports"),
            "path": "/drive/root:/Finance/Reports",
        },
        "file": {
            "mimeType": "application/pdf",
            "hashes": {"sha256Hash": hashlib.sha256(content).hexdigest().upper()},
        },
    }


async def test_folder_item(client: httpx.AsyncClient, corpus: Corpus) -> None:
    folder = (await client.get(item_url(corpus.id("kestrel", "/Finance")))).json()
    sizes = [
        len(corpus.content("kestrel", path))
        for path in ("/Finance/Reports/Q3 report.pdf", "/Finance/FP&A/plan.md")
    ]
    assert folder["folder"] == {"childCount": 2}
    assert folder["size"] == sum(sizes)
    assert folder["parentReference"] == {"id": corpus.id("kestrel", "/"), "path": "/drive/root:"}
    assert "cTag" not in folder
    assert "file" not in folder


async def test_paths_are_percent_encoded(client: httpx.AsyncClient, corpus: Corpus) -> None:
    plan = (await client.get(item_url(corpus.id("kestrel", "/Finance/FP&A/plan.md")))).json()
    assert plan["parentReference"]["path"] == "/drive/root:/Finance/FP%26A"


async def test_unknown_item_is_404(client: httpx.AsyncClient) -> None:
    response = await client.get(item_url("no-such-item"))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "itemNotFound"


async def test_children_are_paged_and_sorted_case_insensitively(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    url = item_url(corpus.id("kestrel", "/Company"), "/children?$top=2")
    pages: list[list[str]] = []
    while True:
        page = (await client.get(url)).json()
        pages.append([child["name"] for child in page["value"]])
        if "@odata.nextLink" not in page:
            break
        url = page["@odata.nextLink"]
        assert url.startswith("http://fw/v1.0/sites/kestrel/drive/items/")
        assert "$top=2&$skiptoken=" in url
    assert pages == [["alpha.md", "Bravo.md"], ["charlie.md", "Delta.md"], ["echo.md"]]


async def test_children_paging_survives_changes_between_pages(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    """Each page starts after the last child returned, so changes between pages can't skip a
    child that was there from the start, or return one twice. Children added behind the cursor
    aren't returned: a crawl takes a delta token first to catch those."""
    company = corpus.id("kestrel", "/Company")

    async def add(name: str) -> None:
        body = {"parent_id": company, "name": name, "content_base64": "", "mime_type": "text/plain"}
        assert (await client.post("/_control/sites/kestrel/items", json=body)).status_code == 201

    async def delete(name: str) -> None:
        url = f"/_control/sites/kestrel/items/{corpus.id('kestrel', f'/Company/{name}')}"
        assert (await client.delete(url)).status_code == 204

    async def page(url: str) -> tuple[list[str], str | None]:
        body = (await client.get(url)).json()
        return [child["name"] for child in body["value"]], body.get("@odata.nextLink")

    first, url = await page(item_url(company, "/children?$top=2"))
    assert first == ["alpha.md", "Bravo.md"]
    await delete("alpha.md")  # behind the cursor: an offset would now skip charlie.md
    await add("aardvark.md")
    await add("Able.md")  # two more in front: an offset would repeat Bravo.md
    assert url is not None
    second, url = await page(url)
    assert second == ["charlie.md", "Delta.md"]
    await delete("charlie.md")
    await add("Beta.md")  # behind the cursor again
    await add("foxtrot.md")  # ahead of it: returned
    assert url is not None
    third, url = await page(url)
    assert (third, url) == (["echo.md", "foxtrot.md"], None)


async def test_children_default_page_and_root_alias(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    by_alias = (await client.get(f"{SITE}/root/children")).json()
    by_id = (await client.get(item_url(corpus.id("kestrel", "/"), "/children"))).json()
    assert by_alias == by_id
    assert [child["name"] for child in by_alias["value"]] == ["Company", "Exec", "Finance", "HR"]
    assert "@odata.nextLink" not in by_alias


async def test_children_top_is_capped_at_200(client: httpx.AsyncClient, corpus: Corpus) -> None:
    parent = corpus.id("kestrel", "/Company")
    for n in range(201):
        body = {
            "parent_id": parent,
            "name": f"bulk-{n:03}.md",
            "content_base64": "eA==",
            "mime_type": "text/markdown",
        }
        assert (await client.post("/_control/sites/kestrel/items", json=body)).status_code == 201
    page = (await client.get(item_url(parent, "/children?$top=500"))).json()
    assert len(page["value"]) == 200
    assert "@odata.nextLink" in page


@pytest.mark.parametrize(
    "query", ["$top=0", "$top=x", "$skiptoken=garbage", "$skiptoken=WzFd", "$skiptoken=WzEsMl0"]
)
async def test_bad_paging_is_400(client: httpx.AsyncClient, query: str) -> None:
    response = await client.get(f"{SITE}/root/children?{query}")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalidRequest"


async def test_content_matches_its_hash(client: httpx.AsyncClient, corpus: Corpus) -> None:
    path = "/Exec/Project Heron memo.pdf"
    response = await client.get(item_url(corpus.id("kestrel", path), "/content"))
    item = (await client.get(item_url(corpus.id("kestrel", path)))).json()
    assert response.status_code == 200
    assert response.content == corpus.content("kestrel", path)
    assert response.headers["content-type"] == "application/pdf"
    assert (
        hashlib.sha256(response.content).hexdigest().upper()
        == (item["file"]["hashes"]["sha256Hash"])
    )
    assert len(response.content) == item["size"]


async def test_uploaded_content_is_served(client: httpx.AsyncClient, corpus: Corpus) -> None:
    item_id = corpus.id("kestrel", "/Company/alpha.md")
    body = {"content_base64": base64.b64encode(b"# new").decode(), "mime_type": "text/plain"}
    await client.put(f"/_control/sites/kestrel/items/{item_id}/content", json=body)
    response = await client.get(item_url(item_id, "/content"))
    assert response.content == b"# new"
    assert response.headers["content-type"].startswith("text/plain")


async def test_folder_has_no_content(client: httpx.AsyncClient) -> None:
    assert (await client.get(f"{SITE}/root/content")).status_code == 400


def grant(
    corpus: Corpus, kind: str, name: str, role: str, inherited_from: str | None = None
) -> dict[str, Any]:
    if kind == "user":
        display = {"tom.whitfield": "Tom Whitfield", "marco.bianchi": "Marco Bianchi"}[name]
        identity = {"user": {"id": corpus.user("kestrel", name), "displayName": display}}
    else:
        identity = {"group": {"id": corpus.group("kestrel", name), "displayName": name}}
    permission: dict[str, Any] = {"roles": [role], "grantedToV2": identity}
    if inherited_from is not None:
        path = "/drive/root:" + inherited_from.replace(" ", "%20")
        permission["inheritedFrom"] = {"id": corpus.id("kestrel", inherited_from), "path": path}
    return permission


async def permissions(client: httpx.AsyncClient, item_id: str) -> list[dict[str, Any]]:
    response = await client.get(item_url(item_id, "/permissions"))
    assert response.status_code == 200
    value: list[dict[str, Any]] = response.json()["value"]
    ids = [p.pop("id") for p in value]
    assert all(re.fullmatch(r"[0-9a-f-]{36}", i) for i in ids)
    return value


async def test_inherited_permissions_name_their_source(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    item = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    assert await permissions(client, item) == [
        grant(corpus, "group", "/Kestrel/Finance", "read", inherited_from="/Finance"),
        grant(corpus, "user", "tom.whitfield", "write", inherited_from="/Finance"),
        grant(corpus, "group", "/Kestrel/Exec", "read", inherited_from="/Finance/Reports"),
    ]


async def test_own_permissions_have_no_source(client: httpx.AsyncClient, corpus: Corpus) -> None:
    folder = corpus.id("kestrel", "/Finance/Reports")
    assert await permissions(client, folder) == [
        grant(corpus, "group", "/Kestrel/Finance", "read", inherited_from="/Finance"),
        grant(corpus, "user", "tom.whitfield", "write", inherited_from="/Finance"),
        grant(corpus, "group", "/Kestrel/Exec", "read"),
    ]


async def test_broken_inheritance_keeps_only_own_grants(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    note = corpus.id("kestrel", "/HR/Casework/case note.pdf")
    assert await permissions(client, note) == [grant(corpus, "user", "marco.bianchi", "read")]
    plan = corpus.id("kestrel", "/Finance/FP&A/plan.md")
    path = "/drive/root:/Finance/FP%26A"
    expected = grant(corpus, "group", "/Kestrel/Finance/FP&A", "write")
    expected["inheritedFrom"] = {"id": corpus.id("kestrel", "/Finance/FP&A"), "path": path}
    assert await permissions(client, plan) == [expected]


async def test_root_shares_nothing(client: httpx.AsyncClient) -> None:
    assert await permissions(client, "root") == []


async def test_permission_ids_are_stable_down_the_tree(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    def ids(response: httpx.Response) -> list[str]:
        return [p["id"] for p in response.json()["value"]]

    folder = await client.get(item_url(corpus.id("kestrel", "/Finance"), "/permissions"))
    file = await client.get(item_url(corpus.id("kestrel", "/Finance/Reports"), "/permissions"))
    assert ids(file)[:2] == ids(folder)


async def test_stronger_role_wins(client: httpx.AsyncClient, corpus: Corpus) -> None:
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    exec_group = corpus.group("kestrel", "/Kestrel/Exec")
    weaker = {
        "principal_type": "group",
        "principal_id": exec_group,
        "principal_name": "/Kestrel/Exec",
        "role": "read",
    }
    body = {"inherit": True, "grants": [weaker]}
    assert (await client.put(f"/_control/sites/kestrel/items/{memo}/sharing", json=body)).is_success
    assert await permissions(client, memo) == [
        grant(corpus, "group", "/Kestrel/Exec", "write", inherited_from="/Exec")
    ]


async def test_site_api_is_503_until_a_corpus_loads(
    make_client: MakeClient, tmp_path: Path
) -> None:
    client = make_client(corpus_dir=tmp_path / "missing")
    for response in (
        await client.get(f"{SITE}/root"),
        await client.get(f"{SITE}/root/delta"),
        await client.post("/v1.0/subscriptions", json={}),
    ):
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "serviceNotReady"
    health = await client.get("/health")
    assert health.status_code == 200
    assert health.json()["corpus_loaded"] is False
