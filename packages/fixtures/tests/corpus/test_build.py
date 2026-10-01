import hashlib
import io
import json
from datetime import date
from pathlib import Path
from typing import Any

import pdfplumber
import pytest

from ac_fixtures.corpus import build
from ac_fixtures.corpus.manifest import dumps
from ac_fixtures.world import World, load_world, parent_path

FOLDER_KEYS = {"id", "path", "name", "parent_id", "kind", "created", "modified"} | {
    "created_by",
    "modified_by",
    "sharing",
}
FILE_KEYS = FOLDER_KEYS | {"file", "doc_id", "format", "traps", "valid_from", "valid_to"}


@pytest.fixture
def world(world_path: Path) -> World:
    return load_world(world_path)


@pytest.fixture
def out(tmp_path: Path) -> Path:
    return tmp_path / "build"


def run(out: Path, world_path: Path, sources_root: Path, jobs: int | None = 1) -> build.BuildReport:
    return build.build(out, world_path=world_path, sources_root=sources_root, jobs=jobs)


@pytest.fixture
def manifest(out: Path, world_path: Path, sources_root: Path) -> dict[str, Any]:
    run(out, world_path, sources_root)
    return json.loads((out / "manifest.json").read_text())


def items(manifest: dict[str, Any], tenant: str) -> dict[str, dict[str, Any]]:
    return {item["path"]: item for item in manifest["sites"][tenant]["items"]}


def files(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_the_report_counts_documents_and_bytes(
    out: Path, world_path: Path, sources_root: Path
) -> None:
    report = run(out, world_path, sources_root)
    listed = json.loads((out / "manifest.json").read_text())["sites"]
    sizes = [i["file"]["size"] for site in listed.values() for i in site["items"] if "file" in i]
    assert (report.documents, report.rendered, report.reused) == (7, 7, 0)
    assert report.bytes == sum(sizes)
    assert (
        report.manifest_sha256 == hashlib.sha256((out / "manifest.json").read_bytes()).hexdigest()
    )


def test_the_manifest_has_the_contract_shape(manifest: dict[str, Any]) -> None:
    assert set(manifest) == {"version", "sites"}
    assert manifest["version"] == 1
    assert set(manifest["sites"]) == {"kestrel", "harbour"}
    for site in manifest["sites"].values():
        assert set(site) == {"items", "users"}
        for item in site["items"]:
            assert set(item) == (FOLDER_KEYS if item["kind"] == "folder" else FILE_KEYS)
            for grant in item["sharing"]["grants"]:
                assert set(grant) == {"principal_type", "principal_id", "principal_name", "role"}


def test_each_site_names_every_user(world: World, manifest: dict[str, Any]) -> None:
    for tenant, spec in world.tenants.items():
        assert manifest["sites"][tenant]["users"] == {
            str(world.user_id(tenant, u.username)): {"username": u.username, "display_name": u.name}
            for u in spec.users
        }
    assert len(manifest["sites"]["kestrel"]["users"]) == 7  # the disabled user too


def test_it_is_written_as_stable_json(out: Path, manifest: dict[str, Any]) -> None:
    text = (out / "manifest.json").read_bytes()
    assert text == dumps(manifest)
    assert text.endswith(b"}\n")


def test_every_folder_and_file_is_listed_parents_first(
    world: World, manifest: dict[str, Any]
) -> None:
    for tenant, spec in world.tenants.items():
        listed = manifest["sites"][tenant]["items"]
        paths = [item["path"] for item in listed]
        folders = ["/", *(folder.path for folder in spec.folders)]
        assert [p for p, i in zip(paths, listed, strict=True) if i["kind"] == "folder"] == sorted(
            folders, key=lambda p: [part for part in p.split("/") if part]
        )
        for index, item in enumerate(listed):
            assert item["id"] == str(world.item_id(tenant, item["path"]))
            if item["path"] == "/":
                assert (index, item["parent_id"], item["name"]) == (0, None, "root")
                continue
            parent = parent_path(item["path"])
            assert item["parent_id"] == str(world.item_id(tenant, parent))
            assert paths.index(parent) < index
            assert item["name"] == item["path"].rsplit("/", 1)[1]


def test_folders_carry_their_own_grants(world: World, manifest: dict[str, Any]) -> None:
    for tenant, spec in world.tenants.items():
        listed = items(manifest, tenant)
        assert listed["/"]["sharing"] == {"inherit": False, "grants": []}
        for folder in spec.folders:
            expected = [
                {
                    "principal_type": "user" if g.user else "group",
                    "principal_id": str(
                        world.user_id(tenant, g.user)
                        if g.user
                        else world.group_id(tenant, g.group or "")
                    ),
                    "principal_name": g.user or g.group,
                    "role": g.role,
                }
                for g in folder.grants
            ]
            assert listed[folder.path]["sharing"] == {"inherit": folder.inherit, "grants": expected}


def test_inheriting_the_manifest_grants_gives_the_worlds_effective_sharing(
    world: World, manifest: dict[str, Any]
) -> None:
    """What fake-workspace will compute from the manifest is what the world says."""
    for tenant, spec in world.tenants.items():
        listed = items(manifest, tenant)
        for folder in spec.folders:
            expected = {
                g.principal_name: g.role for g in world.effective_grants(tenant, folder.path)
            }
            assert effective(listed, folder.path) == expected, folder.path


def effective(listed: dict[str, dict[str, Any]], path: str) -> dict[str, str]:
    """A folder's grants with its parents' (when it inherits), the stronger role winning."""
    item = listed[path]
    inherit = item["sharing"]["inherit"] and path != "/"
    grants = effective(listed, parent_path(path)) if inherit else {}
    for grant in item["sharing"]["grants"]:
        current = grants.get(grant["principal_name"])
        if current is None or (current, grant["role"]) == ("read", "write"):
            grants[grant["principal_name"]] = grant["role"]
    return grants


def test_item_level_sharing_overrides_the_folder(world: World, manifest: dict[str, Any]) -> None:
    listed = items(manifest, "kestrel")
    marco = str(world.user_id("kestrel", "marco.bianchi"))
    assert listed["/HR/Casework/Case Note.pdf"]["sharing"] == {
        "inherit": False,
        "grants": [
            {
                "principal_type": "user",
                "principal_id": marco,
                "principal_name": "marco.bianchi",
                "role": "read",
            }
        ],
    }
    runbook = listed["/Eng/Runbooks/Runbook.md"]["sharing"]
    assert runbook["inherit"] is True
    assert [(g["principal_type"], g["principal_name"], g["role"]) for g in runbook["grants"]] == [
        ("group", "/Kestrel/Eng/Payments", "read"),
        ("user", "lena.fischer", "write"),
    ]
    assert listed["/Exec/Expenses Report.pdf"]["sharing"] == {"inherit": True, "grants": []}


def test_files_point_at_their_blobs(out: Path, manifest: dict[str, Any]) -> None:
    for site in manifest["sites"].values():
        for item in site["items"]:
            if item["kind"] != "file":
                continue
            file = item["file"]
            data = (out / file["blob"]).read_bytes()
            assert file["blob"] == f"blobs/{file['sha256']}.{item['name'].rsplit('.', 1)[1]}"
            assert (len(data), hashlib.sha256(data).hexdigest()) == (file["size"], file["sha256"])
            if item["name"].endswith(".pdf"):
                assert file["mime_type"] == "application/pdf"
                with pdfplumber.open(io.BytesIO(data)) as pdf:
                    assert file["pages"] == len(pdf.pages)
            else:
                assert "pages" not in file


def test_file_metadata_comes_from_the_frontmatter(world: World, manifest: dict[str, Any]) -> None:
    contract = items(manifest, "kestrel")["/Exec/Contract.pdf"]
    assert (contract["doc_id"], contract["format"], contract["traps"]) == (
        "exec-contract",
        "pdf_mixed",
        [],
    )
    assert (contract["valid_from"], contract["valid_to"]) == ("2026-03-03", "2027-03-02")
    assert (
        contract["created_by"]
        == contract["modified_by"]
        == str(world.user_id("kestrel", "amara.okafor"))
    )
    report = items(manifest, "kestrel")["/Exec/Expenses Report.pdf"]
    assert (report["traps"], report["valid_from"], report["valid_to"]) == (["acl-leak"], None, None)
    for item in (contract, report):
        assert item["created"].startswith("2026-03-03T")
        assert item["created"].endswith(":00Z")
        assert item["modified"].startswith("2026-03-04T")


def test_folder_authors_follow_the_first_write_grant(
    world: World, manifest: dict[str, Any]
) -> None:
    expected = {
        ("kestrel", "/"): "tariq.aziz",  # nobody is granted the root: the first admin
        ("kestrel", "/Company"): "ella.brooks",
        ("kestrel", "/HR"): "marco.bianchi",  # peter.hall comes first but is disabled
        ("kestrel", "/HR/Casework"): "marco.bianchi",
        ("kestrel", "/Exec"): "amara.okafor",
        ("kestrel", "/Eng"): "lena.fischer",
        ("kestrel", "/Eng/Runbooks"): "tariq.aziz",  # read grants only
        ("kestrel", "/Eng/Payments"): "omar.haddad",  # its own write grant beats the inherited one
        ("harbour", "/"): "nina.osei",
        ("harbour", "/Policies"): "nina.osei",
    }
    for (tenant, path), username in expected.items():
        item = items(manifest, tenant)[path]
        assert item["created_by"] == item["modified_by"] == str(world.user_id(tenant, username))
        assert item["created"] == item["modified"] == f"{date(2026, 9, 30)}T00:00:00Z"


def test_an_unchanged_build_reuses_everything(
    out: Path, world_path: Path, sources_root: Path
) -> None:
    first = run(out, world_path, sources_root)
    before = files(out)
    second = run(out, world_path, sources_root)
    assert (second.rendered, second.reused) == (0, 7)
    assert second.manifest_sha256 == first.manifest_sha256
    assert files(out) == before


def test_changing_one_source_re_renders_only_that_one(
    out: Path, world_path: Path, sources_root: Path
) -> None:
    run(out, world_path, sources_root)
    old = items(json.loads((out / "manifest.json").read_text()), "kestrel")
    source = sources_root / "kestrel" / "exec-report.md"
    source.write_text(source.read_text().replace("£500", "£750"))
    report = run(out, world_path, sources_root)
    assert (report.rendered, report.reused) == (1, 6)
    new = items(json.loads((out / "manifest.json").read_text()), "kestrel")
    changed = [path for path in new if new[path].get("file") != old[path].get("file")]
    assert changed == ["/Exec/Expenses Report.pdf"]
    blobs = {f"blobs/{p.name}" for p in (out / "blobs").iterdir()}
    assert old["/Exec/Expenses Report.pdf"]["file"]["blob"] not in blobs
    assert blobs == {
        i["file"]["blob"]
        for t in ("kestrel", "harbour")
        for i in items(json.loads((out / "manifest.json").read_text()), t).values()
        if i["kind"] == "file"
    }


def test_a_world_change_re_renders_everything(
    out: Path, world_path: Path, sources_root: Path
) -> None:
    run(out, world_path, sources_root)
    world_path.write_text(world_path.read_text() + "# a comment changes nothing\n")
    assert run(out, world_path, sources_root).rendered == 0
    world_path.write_text(world_path.read_text().replace("title: Security", "title: Security Lead"))
    assert run(out, world_path, sources_root).rendered == 7


def test_a_damaged_blob_is_rendered_again(out: Path, world_path: Path, sources_root: Path) -> None:
    run(out, world_path, sources_root)
    entry = json.loads((out / "inputs.json").read_text())["kestrel/exec-report"]
    (out / entry["blob"]).write_bytes(b"damaged")
    report = run(out, world_path, sources_root)
    assert report.rendered == 1
    assert (out / entry["blob"]).read_bytes() != b"damaged"


def test_two_builds_are_byte_identical(
    tmp_path: Path, world_path: Path, sources_root: Path
) -> None:
    # One build renders in this process, the other in a pool of workers.
    run(tmp_path / "one", world_path, sources_root, jobs=1)
    run(tmp_path / "two", world_path, sources_root, jobs=None)
    assert files(tmp_path / "one") == files(tmp_path / "two")


def test_render_failures_are_collected(out: Path, world_path: Path, sources_root: Path) -> None:
    for name in ("exec-report", "exec-contract"):
        source = sources_root / "kestrel" / f"{name}.md"
        source.write_text(source.read_text() + "\nUp \u2192 down\n")
    pack = sources_root / "kestrel" / "company-pack.md"
    pack.write_text(pack.read_text() + "\nA vertical tab \x0b here\n")
    with pytest.raises(build.CorpusError) as caught:
        run(out, world_path, sources_root)
    problems = sorted(caught.value.problems)
    assert len(problems) == 3
    assert "company-pack.md: ValueError" in problems[0]
    assert all("U+2192" in problem for problem in problems[1:])
    assert not (out / "manifest.json").exists()


def test_after_a_failure_only_the_failed_documents_render_again(
    out: Path, world_path: Path, sources_root: Path
) -> None:
    source = sources_root / "kestrel" / "exec-report.md"
    good = source.read_text()
    source.write_text(good + "\nUp \u2192 down\n")
    with pytest.raises(build.CorpusError):
        run(out, world_path, sources_root)
    source.write_text(good)
    assert run(out, world_path, sources_root).rendered == 1
