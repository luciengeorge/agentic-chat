import base64
from typing import Any

import httpx

from ac_fake_workspace.testing import Corpus, MakeClient

DELTA = "/v1.0/sites/kestrel/drive/root/delta"
CONTROL = "/_control/sites/kestrel/items"
PREFER = {
    "Prefer": "deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges"
}
SHARED = "@microsoft.graph.sharedChanged"


async def sync(
    client: httpx.AsyncClient, url: str, *, prefer: bool = False
) -> tuple[list[dict[str, Any]], str]:
    """Follow nextLinks to the end of a round; return its items and the deltaLink."""
    items: list[dict[str, Any]] = []
    while True:
        response = await client.get(url, headers=PREFER if prefer else {})
        assert response.status_code == 200, response.text
        page = response.json()
        items.extend(page["value"])
        if "@odata.deltaLink" in page:
            assert "@odata.nextLink" not in page
            return items, page["@odata.deltaLink"]
        url = page["@odata.nextLink"]


async def latest(client: httpx.AsyncClient) -> str:
    page = (await client.get(f"{DELTA}?token=latest")).json()
    assert page["value"] == []
    return page["@odata.deltaLink"]


async def control(
    client: httpx.AsyncClient, method: str, path: str, body: Any = None
) -> httpx.Response:
    response = await client.request(method, f"{CONTROL}{path}", json=body)
    assert response.is_success, response.text
    return response


def group_grant(corpus: Corpus, path: str, role: str) -> dict[str, str]:
    return {
        "principal_type": "group",
        "principal_id": corpus.group("kestrel", path),
        "principal_name": path,
        "role": role,
    }


async def test_full_enumeration_returns_every_item_in_creation_order(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    pages = 0
    url = f"{DELTA}?$top=4"
    items: list[dict[str, Any]] = []
    while True:
        page = (await client.get(url)).json()
        pages += 1
        items.extend(page["value"])
        if "@odata.nextLink" not in page:
            assert "@odata.deltaLink" in page
            break
        assert "@odata.deltaLink" not in page
        url = page["@odata.nextLink"]
        assert url.startswith("http://fw/v1.0/sites/kestrel/drive/root/delta?")
    assert pages == 5
    assert [item["id"] for item in items] == [
        corpus.id("kestrel", p) for p in corpus.paths("kestrel")
    ]
    assert items[0]["root"] == {}
    for item in items[1:]:
        # Delta never sends paths (renaming a folder doesn't return its descendants) or cTags.
        assert set(item["parentReference"]) == {"id"}
        assert "cTag" not in item
        assert SHARED not in item


async def test_latest_token_skips_the_current_state(client: httpx.AsyncClient) -> None:
    link = await latest(client)
    items, again = await sync(client, link)
    assert items == []
    assert again == link


async def test_created_file_appears(client: httpx.AsyncClient, corpus: Corpus) -> None:
    link = await latest(client)
    body = {
        "parent_id": corpus.id("kestrel", "/Company"),
        "name": "new.md",
        "content_base64": base64.b64encode(b"hello").decode(),
        "mime_type": "text/markdown",
    }
    created = (await control(client, "POST", "", body)).json()
    items, _ = await sync(client, link)
    assert [item["id"] for item in items] == [created["id"]]
    assert items[0]["name"] == "new.md"
    assert items[0]["size"] == 5
    assert items[0]["parentReference"] == {"id": corpus.id("kestrel", "/Company")}


async def test_move_shows_the_new_parent(client: httpx.AsyncClient, corpus: Corpus) -> None:
    report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    exec_folder = corpus.id("kestrel", "/Exec")
    before = (await client.get(f"/v1.0/sites/kestrel/drive/items/{report}")).json()
    link = await latest(client)
    await control(client, "POST", f"/{report}/move", {"parent_id": exec_folder})
    items, _ = await sync(client, link)
    assert [(item["id"], item["parentReference"]) for item in items] == [
        (report, {"id": exec_folder})
    ]
    assert SHARED not in items[0]
    # Its effective sharing changed with its parent, which the Prefer header reveals.
    items, _ = await sync(client, link, prefer=True)
    assert [(item["id"], item.get(SHARED)) for item in items] == [(report, "True")]
    item = (await client.get(f"/v1.0/sites/kestrel/drive/items/{report}")).json()
    assert item["parentReference"]["path"] == "/drive/root:/Exec"
    assert item["eTag"] != before["eTag"]
    assert item["cTag"] == before["cTag"]


async def test_moved_folder_descendants_appear_only_as_sharing_changes(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    reports = corpus.id("kestrel", "/Finance/Reports")
    report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    link = await latest(client)
    await control(client, "POST", f"/{reports}/move", {"parent_id": corpus.id("kestrel", "/Exec")})
    items, _ = await sync(client, link)
    assert [item["id"] for item in items] == [reports]
    items, _ = await sync(client, link, prefer=True)
    assert [(item["id"], item.get(SHARED)) for item in items] == [
        (reports, "True"),
        (report, "True"),
    ]


async def test_move_with_the_same_effective_sharing_is_not_a_sharing_change(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    note = corpus.id("kestrel", "/HR/Casework/case note.pdf")  # inherit: false
    link = await latest(client)
    await control(client, "POST", f"/{note}/move", {"parent_id": corpus.id("kestrel", "/HR")})
    items, _ = await sync(client, link, prefer=True)
    assert [(item["id"], SHARED in item) for item in items] == [(note, False)]


async def test_rename_appears_once_with_the_latest_name(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    reports = corpus.id("kestrel", "/Finance/Reports")
    report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    before = (await client.get(f"/v1.0/sites/kestrel/drive/items/{reports}")).json()
    link = await latest(client)
    await control(client, "POST", f"/{reports}/rename", {"name": "Reports 2026"})
    await control(client, "POST", f"/{reports}/rename", {"name": "Board reports"})
    items, _ = await sync(client, link)
    assert [(item["id"], item["name"]) for item in items] == [(reports, "Board reports")]
    assert items[0]["eTag"] != before["eTag"]
    child = (await client.get(f"/v1.0/sites/kestrel/drive/items/{report}")).json()
    assert child["parentReference"]["path"] == "/drive/root:/Finance/Board%20reports"


async def test_rename_changes_the_etag_but_not_the_ctag(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    url = f"/v1.0/sites/kestrel/drive/items/{memo}"
    before = (await client.get(url)).json()
    await control(client, "POST", f"/{memo}/rename", {"name": "Heron.pdf"})
    after = (await client.get(url)).json()
    assert after["eTag"] != before["eTag"]
    assert after["cTag"] == before["cTag"]


async def test_new_version_changes_both_tags_and_the_hash(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    url = f"/v1.0/sites/kestrel/drive/items/{memo}"
    before = (await client.get(url)).json()
    link = await latest(client)
    body = {"content_base64": base64.b64encode(b"version two").decode()}
    await control(client, "PUT", f"/{memo}/content", body)
    items, _ = await sync(client, link)
    assert [item["id"] for item in items] == [memo]
    assert items[0]["size"] == len(b"version two")
    assert items[0]["file"]["mimeType"] == "application/pdf"
    assert items[0]["file"]["hashes"] != before["file"]["hashes"]
    after = (await client.get(url)).json()
    assert after["eTag"] != before["eTag"]
    assert after["cTag"] != before["cTag"]


async def test_folder_delete_cascades(client: httpx.AsyncClient, corpus: Corpus) -> None:
    def kestrel(path: str) -> str:
        return corpus.id("kestrel", path)

    link = await latest(client)
    await control(client, "DELETE", f"/{kestrel('/HR')}")
    items, _ = await sync(client, link)
    # Children first, so a folder is empty by the time its own delete arrives.
    assert items == [
        {
            "id": kestrel("/HR/Casework/case note.pdf"),
            "deleted": {"state": "deleted"},
            "parentReference": {"id": kestrel("/HR/Casework")},
        },
        {
            "id": kestrel("/HR/Casework"),
            "deleted": {"state": "deleted"},
            "parentReference": {"id": kestrel("/HR")},
        },
        {
            "id": kestrel("/HR"),
            "deleted": {"state": "deleted"},
            "parentReference": {"id": kestrel("/")},
        },
    ]
    for path in ("/HR", "/HR/Casework/case note.pdf"):
        response = await client.get(f"/v1.0/sites/kestrel/drive/items/{kestrel(path)}")
        assert response.status_code == 404
    root = (await client.get("/v1.0/sites/kestrel/drive/root/children")).json()
    assert [child["name"] for child in root["value"]] == ["Company", "Exec", "Finance"]
    everything, _ = await sync(client, DELTA)
    assert kestrel("/HR") not in [item["id"] for item in everything]


async def test_sharing_changes_need_the_prefer_header(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    finance = corpus.id("kestrel", "/Finance")
    reports = corpus.id("kestrel", "/Finance/Reports")
    report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    plan = corpus.id("kestrel", "/Finance/FP&A/plan.md")
    url = "/v1.0/sites/kestrel/drive/items/{}"
    ids = (finance, reports, report, plan)
    before = {i: (await client.get(url.format(i))).json() for i in ids}
    link = await latest(client)
    body = {"inherit": True, "grants": [group_grant(corpus, "/Kestrel/Finance", "read")]}
    await control(client, "PUT", f"/{finance}/sharing", body)

    items, _ = await sync(client, link)
    assert items == []
    items, _ = await sync(client, link, prefer=True)
    # The folder and everything that inherits from it; FP&A broke inheritance, so it's untouched.
    assert [(item["id"], item[SHARED]) for item in items] == [
        (finance, "True"),
        (reports, "True"),
        (report, "True"),
    ]
    # Every item whose effective sharing changed gets a new eTag, so a connector that skips
    # unchanged eTags can't keep the revoked grant. Content is untouched, so cTags stay.
    after = {i: (await client.get(url.format(i))).json() for i in ids}
    changed = [i for i in ids if after[i]["eTag"] != before[i]["eTag"]]
    assert changed == [finance, reports, report]
    assert after[report]["cTag"] == before[report]["cTag"]
    permissions = (await client.get(url.format(report) + "/permissions")).json()["value"]
    tom = corpus.user("kestrel", "tom.whitfield")
    assert tom not in [p["grantedToV2"].get("user", {}).get("id") for p in permissions]


async def test_a_grant_moving_to_another_ancestor_is_a_sharing_change(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    """The same role from a nearer ancestor changes the permission's `inheritedFrom` and id."""
    finance = corpus.id("kestrel", "/Finance")
    reports = corpus.id("kestrel", "/Finance/Reports")
    report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    tom = {
        "principal_type": "user",
        "principal_id": corpus.user("kestrel", "tom.whitfield"),
        "principal_name": "tom.whitfield",
        "role": "write",
    }
    finance_read = group_grant(corpus, "/Kestrel/Finance", "read")
    both = [group_grant(corpus, "/Kestrel/Exec", "read"), finance_read]
    await control(client, "PUT", f"/{reports}/sharing", {"inherit": True, "grants": both})
    url = f"/v1.0/sites/kestrel/drive/items/{report}"
    before = (await client.get(url)).json()
    link = await latest(client)
    await control(client, "PUT", f"/{finance}/sharing", {"inherit": True, "grants": [tom]})
    items, _ = await sync(client, link, prefer=True)
    assert [(item["id"], item.get(SHARED)) for item in items] == [
        (finance, "True"),
        (reports, "True"),
        (report, "True"),
    ]
    assert (await client.get(url)).json()["eTag"] != before["eTag"]
    permissions = (await client.get(f"{url}/permissions")).json()["value"]
    sources = {
        p["grantedToV2"]["group"]["displayName"]: p["inheritedFrom"]["id"]
        for p in permissions
        if "group" in p["grantedToV2"]
    }
    assert sources["/Kestrel/Finance"] == reports


async def test_content_and_sharing_change_together(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    link = await latest(client)
    await control(client, "PUT", f"/{memo}/content", {"content_base64": "eA=="})
    body = {"inherit": False, "grants": [group_grant(corpus, "/Kestrel/Exec", "read")]}
    await control(client, "PUT", f"/{memo}/sharing", body)
    items, _ = await sync(client, link)
    assert [(item["id"], SHARED in item) for item in items] == [(memo, False)]
    items, _ = await sync(client, link, prefer=True)
    assert [(item["id"], item.get(SHARED)) for item in items] == [(memo, "True")]


async def test_changes_come_in_order_of_first_change(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf")
    link = await latest(client)
    await control(client, "POST", f"/{memo}/rename", {"name": "Heron.pdf"})
    await control(client, "POST", f"/{report}/rename", {"name": "Q3.pdf"})
    await control(client, "POST", f"/{memo}/rename", {"name": "Heron v2.pdf"})
    items, _ = await sync(client, link)
    assert [(item["id"], item["name"]) for item in items] == [
        (memo, "Heron v2.pdf"),
        (report, "Q3.pdf"),
    ]


async def test_changes_during_a_round_wait_for_the_next(
    client: httpx.AsyncClient, corpus: Corpus
) -> None:
    first = (await client.get(f"{DELTA}?$top=5")).json()
    memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf")
    await control(client, "POST", f"/{memo}/rename", {"name": "Heron.pdf"})
    rest, link = await sync(client, first["@odata.nextLink"])
    ids = [item["id"] for item in first["value"] + rest]
    assert ids == [corpus.id("kestrel", p) for p in corpus.paths("kestrel")]
    items, _ = await sync(client, link)
    assert [(item["id"], item["name"]) for item in items] == [(memo, "Heron.pdf")]


async def test_stale_token_after_reset_is_410(client: httpx.AsyncClient) -> None:
    link = await latest(client)
    assert (await client.post("/_control/reset")).status_code == 200
    response = await client.get(link)
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "resyncRequired"
    fresh = response.headers["location"]
    assert "token" not in fresh
    items, _ = await sync(client, fresh)
    assert items


async def test_a_restart_keeps_tokens_only_for_the_same_corpus(
    make_client: MakeClient, corpus: Corpus
) -> None:
    link = await latest(make_client())
    assert (await make_client().get(link)).status_code == 200
    manifest = corpus.dir / "manifest.json"
    manifest.write_text(manifest.read_text().replace("Tom Whitfield", "Tom W."))
    restarted = make_client()
    stale = await restarted.get(link)
    assert stale.status_code == 410
    assert stale.json()["error"]["innerError"] == {"code": "resyncChangesApplyDifferences"}
    location = httpx.URL(stale.headers["location"])
    assert (location.host, location.path) == ("fw", DELTA)
    assert "token" not in location.params
    items, _ = await sync(restarted, str(location))
    assert [item["id"] for item in items] == [
        corpus.id("kestrel", p) for p in corpus.paths("kestrel")
    ]


async def test_malformed_token_is_400(client: httpx.AsyncClient) -> None:
    for token in ("not-a-token", "a2VzdHJlbA"):
        response = await client.get(f"{DELTA}?token={token}")
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalidRequest"


async def test_tokens_from_another_site_are_rejected(client: httpx.AsyncClient) -> None:
    token = httpx.URL(await latest(client)).params["token"]
    harbour = {"Authorization": "Bearer dev-workspace-harbour"}
    url = f"/v1.0/sites/harbour/drive/root/delta?token={token}"
    assert (await client.get(url, headers=harbour)).status_code == 400


async def test_same_calls_give_the_same_ids_tags_and_tokens(
    make_client: MakeClient, corpus: Corpus
) -> None:
    async def run(client: httpx.AsyncClient) -> list[Any]:
        await client.post("/_control/clock", json={"now": "2026-10-01T12:00:00Z"})
        link = await latest(client)
        body = {
            "parent_id": corpus.id("kestrel", "/Exec"),
            "name": "Heron board pack.pdf",
            "content_base64": base64.b64encode(b"pack").decode(),
            "mime_type": "application/pdf",
        }
        created = (await control(client, "POST", "", body)).json()
        await control(
            client,
            "POST",
            f"/{corpus.id('kestrel', '/Finance/Reports')}/move",
            {"parent_id": corpus.id("kestrel", "/Exec"), "name": "Reports"},
        )
        share = {"inherit": True, "grants": [group_grant(corpus, "/Kestrel", "read")]}
        await control(client, "PUT", f"/{corpus.id('kestrel', '/HR')}/sharing", share)
        await control(client, "DELETE", f"/{corpus.id('kestrel', '/Company/echo.md')}")
        page1 = (await client.get(link + "&$top=3", headers=PREFER)).json()
        items, final = await sync(client, link, prefer=True)
        full, full_link = await sync(client, f"{DELTA}?$top=7")
        return [created, page1, items, final, full, full_link]

    first = await run(make_client())
    second = await run(make_client())
    assert first == second
    assert first[1]["@odata.nextLink"] != first[3]
