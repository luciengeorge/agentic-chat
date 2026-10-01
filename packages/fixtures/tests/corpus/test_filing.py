import io
import re
import shutil
from pathlib import Path

import pdfplumber
import pytest
from pdfplumber.pdf import PDF

from ac_core.slots import find_repo_root
from ac_fixtures.corpus import blocks, build, filing
from ac_fixtures.corpus.render import render
from ac_fixtures.sources import Source, load_sources
from ac_fixtures.world import load_world

STUB = find_repo_root() / "fixtures/corpus/sources/kestrel/legal-regulatory-filing-2026.md"


def pages(content: list[blocks.Block]) -> list[list[blocks.Block]]:
    out: list[list[blocks.Block]] = [[]]
    for block in content:
        if isinstance(block, blocks.PageBreak):
            out.append([])
        else:
            out[-1].append(block)
    return out


def test_the_generator_is_deterministic_and_seeded() -> None:
    first = filing.build("", pages=3000, seed=2026)
    assert first == filing.build("", pages=3000, seed=2026)
    assert first != filing.build("", pages=3000, seed=2027)
    assert len(pages(first)) == 3000


def test_the_last_annex_takes_the_remaining_pages() -> None:
    sheets = pages(filing.build("", pages=2600, seed=1))
    assert len(sheets) == 2600
    heading = sheets[-1][0]
    assert isinstance(heading, blocks.Heading)
    assert blocks.plain(heading.content).endswith("sheet 101 of 101")


def test_page_sections_are_added_to_their_page() -> None:
    body = "Commentary.\n\n## Page 2,417\n\nThe needle.\n\n## Page 5\n\n- one\n"
    sheets = pages(filing.build(body, pages=3000, seed=2026))
    assert sheets[2416][-1] == blocks.Paragraph((blocks.Span("The needle."),))
    assert isinstance(sheets[4][-1], blocks.ListBlock)
    assert not any("Commentary" in line for page in sheets for line in blocks.lines(page))


@pytest.mark.parametrize(
    ("body", "pages_", "problem"),
    [
        ("## Notes\n\nx\n", 3000, "headed"),
        ("## Page 3001\n\nx\n", 3000, "out of range"),
        ("## Page 9\n\nx\n\n## Page 9\n\ny\n", 3000, "set twice"),
        ("", 100, "more than"),
    ],
)
def test_bad_bodies_are_refused(body: str, pages_: int, problem: str) -> None:
    with pytest.raises(blocks.RenderError, match=problem):
        filing.build(body, pages=pages_, seed=1)


def test_the_incident_register_agrees_with_compliance_reporting() -> None:
    """Q1 2026: four P1 incidents and major incident MI-2026-03; Q2 2026: none."""
    content = filing.build("", pages=3000, seed=2026)
    p1 = [line for page in pages(content) for line in blocks.lines(page) if " | P1 | " in line]
    in_2026 = [line for line in p1 if "2026 |" in line]
    assert len(in_2026) == 5
    assert sum(line.startswith("MI-2026-03 | 6 February 2026") for line in in_2026) == 1
    assert not any(month in line for line in in_2026 for month in ("April", "May", "June"))


def test_the_people_in_the_filing_are_in_the_world() -> None:
    users = {user.username: user for user in load_world().tenants["kestrel"].users}
    content = filing.build("", pages=3000, seed=1)
    text = " ".join(line for page in pages(content) for line in blocks.lines(page))
    for username in ("helen.marsh", "sofia.lindqvist", "tom.whitfield"):
        assert f"{users[username].name}, {users[username].title}" in text
    for username in ("amara.okafor", "daniel.reyes", "priya.nair"):
        assert users[username].name in text


def stub_source(root: Path) -> Source:
    """The real filing source alone in a sources tree, so other lanes' files can't interfere."""
    (root / "kestrel").mkdir(parents=True)
    shutil.copy(STUB, root / "kestrel" / STUB.name)
    (source,) = load_sources(load_world(), root)
    return source


@pytest.fixture(scope="module")
def rendered(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    """The real filing, rendered once (3,000 pages, a few seconds)."""
    source = stub_source(tmp_path_factory.mktemp("filing") / "sources")
    return render(build.document(load_world(), source)).data


def _text(pdf: PDF, number: int) -> str:
    return " ".join((pdf.pages[number - 1].extract_text() or "").split())


def test_the_filing_is_3000_pages_with_its_facts_on_their_pages(rendered: bytes) -> None:
    sections = re.findall(r"^## Page ([\d,]+)\n\n(.+?)\.", STUB.read_text(), flags=re.M)
    assert len(sections) >= 5
    with pdfplumber.open(io.BytesIO(rendered)) as pdf:
        assert len(pdf.pages) == 3000
        for number, sentence in sections:
            page = int(number.replace(",", ""))
            assert " ".join(sentence.replace("**", "").split()) in _text(pdf, page), page
        assert "Annex A. Kestrel Payouts, GBP: Thursday 25 June 2026" in _text(pdf, 2468)
        assert "PR-2026-0625-01" in _text(pdf, 2468)
        assert "PR-2026-0625-01" not in _text(pdf, 2467) + _text(pdf, 2469)
        assert "Annex A. Kestrel Checkout, EUR: Wednesday 17 June 2026" in _text(pdf, 2417)
        # each fact sits with the rows it is about
        assert "Position at 17:00 on Friday 14 November 2025" in _text(pdf, 130)
        assert "Excess (shortfall) (£1,284,316.40)" in _text(pdf, 130)
        assert "Position at 17:00 on Wednesday 11 March 2026 Account BM-SG-02" in _text(pdf, 328)
        assert "CMP-2026-01171 14 March 2026 Accounts Fees and charges Not upheld" in _text(
            pdf, 845
        )
        assert "MI-2026-03 6 February 2026 Card authorisation P1 41 min Yes" in _text(pdf, 883)
        assert "M-221449 5691 Clothing North West Exited 15 Mar 2026" in _text(pdf, 2861)
        assert "Page 2417 of 3000" in _text(pdf, 2417)
        assert len(pdf.pages[2416].find_tables()) == 1


def test_the_contents_page_points_at_the_parts(rendered: bytes) -> None:
    with pdfplumber.open(io.BytesIO(rendered)) as pdf:
        contents = _text(pdf, 2)
        assert "4 Safeguarding of relevant funds 29 to 403" in contents
        assert "B Annex B: merchant movements register 2,500 to 3,000" in contents
        assert "Part 4. Safeguarding of relevant funds" in _text(pdf, 29)
        assert "Annex B. Merchant movements register, sheet 1 of 501" in _text(pdf, 2500)


def test_the_stub_is_a_valid_source(tmp_path: Path) -> None:
    meta = stub_source(tmp_path / "sources").meta
    assert (meta.format, meta.folder, meta.author) == (
        "generated",
        "/Legal/Regulatory",
        "helen.marsh",
    )
    assert (meta.generator, meta.pages, meta.seed, meta.traps) == (
        "regulatory_filing",
        3000,
        2026,
        ("fan-out",),
    )
