import hashlib
import io
import json
import shutil
import zlib
from collections.abc import Callable
from datetime import date
from importlib import metadata
from pathlib import Path
from typing import Any

import pdfplumber
import pytest
import yaml

from ac_fixtures.corpus import build, pdf
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


def run(out: Path, world_path: Path, sources_root: Path, jobs: int | None = 1) -> build.BuildReport:
    return build.build(out, world_path=world_path, sources_root=sources_root, jobs=jobs)


@pytest.fixture(scope="module")
def manifest(small_build: tuple[Path, build.BuildReport]) -> dict[str, Any]:
    return json.loads((small_build[0] / "manifest.json").read_text())


def items(manifest: dict[str, Any], tenant: str) -> dict[str, dict[str, Any]]:
    return {item["path"]: item for item in manifest["sites"][tenant]["items"]}


def files(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_the_report_counts_documents_and_bytes(
    small_build: tuple[Path, build.BuildReport],
) -> None:
    out, report = small_build
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
        assert set(site) == {"items", "users", "groups"}
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


def test_each_site_names_every_group(world: World, manifest: dict[str, Any]) -> None:
    """By id, so fake-workspace can check that a group grant names a group of that site."""
    for tenant, spec in world.tenants.items():
        groups = manifest["sites"][tenant]["groups"]
        assert groups == {str(world.group_id(tenant, path)): {"path": path} for path in spec.groups}
        for item in manifest["sites"][tenant]["items"]:
            for grant in item["sharing"]["grants"]:
                if grant["principal_type"] == "group":
                    assert groups[grant["principal_id"]] == {"path": grant["principal_name"]}
    assert len(manifest["sites"]["kestrel"]["groups"]) == 5


def test_it_is_written_as_stable_json(small_build: tuple[Path, build.BuildReport]) -> None:
    """Keys sorted at every level, two-space indents, no trailing spaces, a final newline."""
    text = (small_build[0] / "manifest.json").read_text(encoding="utf-8")
    orders: list[list[str]] = []

    def record(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        orders.append([key for key, _ in pairs])
        return dict(pairs)

    json.loads(text, object_pairs_hook=record)
    assert len(orders) > 50
    assert all(keys == sorted(keys) for keys in orders)
    lines = text.split("\n")
    assert (lines[0], lines[1], lines[-2:]) == ("{", '  "sites": {', ["}", ""])
    for line in lines:
        indent = len(line) - len(line.lstrip(" "))
        assert indent % 2 == 0, line
        assert line == line.rstrip(), line


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


def test_the_manifest_grants_give_the_worlds_effective_sharing(
    tmp_path: Path, world_path: Path, world: World, manifest: dict[str, Any]
) -> None:
    """fake-workspace works sharing out from each folder's own grants and inherit flag. A world
    whose folders take theirs from the manifest resolves every folder as the real one does."""
    spec = yaml.safe_load(world_path.read_text(encoding="utf-8"))
    for tenant, tenant_spec in spec["tenants"].items():
        listed = items(manifest, tenant)
        tenant_spec["folders"] = [
            {
                "path": folder["path"],
                "inherit": listed[folder["path"]]["sharing"]["inherit"],
                "grants": [
                    {grant["principal_type"]: grant["principal_name"], "role": grant["role"]}
                    for grant in listed[folder["path"]]["sharing"]["grants"]
                ],
            }
            for folder in tenant_spec["folders"]
        ]
    rebuilt_path = tmp_path / "rebuilt.yaml"
    rebuilt_path.write_text(yaml.safe_dump(spec), encoding="utf-8")
    rebuilt = load_world(rebuilt_path)
    for tenant, tenant_spec in world.tenants.items():
        for folder in tenant_spec.folders:
            expected = world.effective_grants(tenant, folder.path)
            assert rebuilt.effective_grants(tenant, folder.path) == expected, folder.path


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


def test_files_point_at_their_blobs(
    small_build: tuple[Path, build.BuildReport], manifest: dict[str, Any]
) -> None:
    out = small_build[0]
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
    out: Path, world_path: Path, sources_root: Path, small_build: tuple[Path, build.BuildReport]
) -> None:
    before = files(out)
    report = run(out, world_path, sources_root)
    assert (report.rendered, report.reused) == (0, 7)
    assert report.manifest_sha256 == small_build[1].manifest_sha256
    assert files(out) == before


def test_changing_one_source_re_renders_only_that_one(
    out: Path, world_path: Path, sources_root: Path
) -> None:
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
    world_path.write_text(world_path.read_text() + "# a comment changes nothing\n")
    assert run(out, world_path, sources_root).rendered == 0
    world_path.write_text(world_path.read_text().replace("title: Security", "title: Security Lead"))
    assert run(out, world_path, sources_root).rendered == 7


# The libraries whose versions can change the rendered bytes.
WRITERS = ("lxml", "markdown-it-py", "numpy", "pillow", "pypdfium2", "python-docx", "reportlab")


def versions_with(library: str, version: str) -> Callable[[str], str]:
    """importlib.metadata.version, except that `library` reports `version`."""
    real = metadata.version
    return lambda name: version if name == library else real(name)


def test_the_renderer_fingerprint_covers_its_code_font_and_libraries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Changing any corpus module, the world or source loader, the vendored font, a library that
    writes the bytes, Python or zlib changes the fingerprint."""
    real = build.renderer_fingerprint()
    package = tmp_path / "ac_fixtures"
    shutil.copytree(
        Path(build.__file__).parent.parent, package, ignore=shutil.ignore_patterns("__pycache__")
    )
    font = tmp_path / pdf.font_path().name
    shutil.copy(pdf.font_path(), font)
    monkeypatch.setattr(build, "__file__", str(package / "corpus" / "build.py"))
    monkeypatch.setattr(build.pdf, "font_path", lambda: font)
    assert build.renderer_fingerprint() == real

    modules = sorted((package / "corpus").glob("*.py"))
    assert len(modules) >= 9
    for path in [*modules, package / "world.py", package / "sources.py", font]:
        data = path.read_bytes()
        path.write_bytes(data + b"\n")
        assert build.renderer_fingerprint() != real, path.name
        path.write_bytes(data)

    for library in WRITERS:
        with monkeypatch.context() as patch:
            patch.setattr(build.metadata, "version", versions_with(library, "0"))
            assert build.renderer_fingerprint() != real, library
    with monkeypatch.context() as patch:
        patch.setattr(build.platform, "python_version", lambda: "3.0.0")
        assert build.renderer_fingerprint() != real
    with monkeypatch.context() as patch:
        patch.setattr(build.zlib, "ZLIB_RUNTIME_VERSION", f"{zlib.ZLIB_RUNTIME_VERSION}.1")
        assert build.renderer_fingerprint() != real


def test_a_renderer_change_re_renders_everything(
    out: Path, world_path: Path, sources_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(build.metadata, "version", versions_with("reportlab", "0"))
    assert run(out, world_path, sources_root).rendered == 7


def test_a_damaged_blob_is_rendered_again(out: Path, world_path: Path, sources_root: Path) -> None:
    entry = json.loads((out / "inputs.json").read_text())["kestrel/exec-report"]
    (out / entry["blob"]).write_bytes(b"damaged")
    report = run(out, world_path, sources_root)
    assert report.rendered == 1
    assert (out / entry["blob"]).read_bytes() != b"damaged"


def test_two_builds_are_byte_identical(
    tmp_path: Path,
    world_path: Path,
    sources_root: Path,
    small_build: tuple[Path, build.BuildReport],
) -> None:
    # The small build rendered in this process; this one renders in a pool of workers.
    run(tmp_path / "pool", world_path, sources_root, jobs=None)
    assert files(tmp_path / "pool") == files(small_build[0])


def test_render_failures_are_collected(
    tmp_path: Path, world_path: Path, sources_root: Path
) -> None:
    for name in ("exec-report", "exec-contract"):
        source = sources_root / "kestrel" / f"{name}.md"
        source.write_text(source.read_text() + "\nUp \u2192 down\n")
    pack = sources_root / "kestrel" / "company-pack.md"
    pack.write_text(pack.read_text() + "\nA vertical tab \x0b here\n")
    fresh = tmp_path / "fresh"
    with pytest.raises(build.CorpusError) as caught:
        run(fresh, world_path, sources_root)
    problems = sorted(caught.value.problems)
    assert len(problems) == 3
    assert "company-pack.md: ValueError" in problems[0]
    assert all("U+2192" in problem for problem in problems[1:])
    assert not (fresh / "manifest.json").exists()


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
