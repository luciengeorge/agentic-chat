import io
import json
import re
import shutil
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import pdfplumber
import pytest
from pdfplumber.pdf import PDF

from ac_core.slots import find_repo_root
from ac_fixtures.corpus import blocks, filing
from ac_fixtures.sources import Source, load_sources
from ac_fixtures.world import load_world

SOURCES = find_repo_root() / "fixtures/corpus/sources/kestrel"
STUB = SOURCES / "legal-regulatory-filing-2026.md"
Page = list[blocks.Block]


def pages(content: list[blocks.Block]) -> list[Page]:
    out: list[Page] = [[]]
    for block in content:
        if isinstance(block, blocks.PageBreak):
            out.append([])
        else:
            out[-1].append(block)
    return out


@pytest.fixture(scope="module")
def sheets() -> list[Page]:
    """The real filing's pages, as blocks."""
    body = STUB.read_text(encoding="utf-8").split("---\n", 2)[2]
    return pages(filing.build(body, pages=3000, seed=2026))


def test_the_generator_is_deterministic_and_seeded() -> None:
    first = filing.build("", pages=2600, seed=2026)
    assert first == filing.build("", pages=2600, seed=2026)
    assert first != filing.build("", pages=2600, seed=2027)
    assert len(pages(first)) == 2600


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


def test_the_incident_register_agrees_with_compliance_reporting(sheets: list[Page]) -> None:
    """Q1 2026: four P1 incidents and major incident MI-2026-03; Q2 2026: none."""
    p1 = [line for page in sheets for line in blocks.lines(page) if " | P1 | " in line]
    in_2026 = [line for line in p1 if "2026 |" in line]
    assert len(in_2026) == 5
    assert sum(line.startswith("MI-2026-03 | 6 February 2026") for line in in_2026) == 1
    assert not any(month in line for line in in_2026 for month in ("April", "May", "June"))


def test_the_people_in_the_filing_are_in_the_world(sheets: list[Page]) -> None:
    users = {user.username: user for user in load_world().tenants["kestrel"].users}
    text = " ".join(line for page in sheets for line in blocks.lines(page))
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
def rendered(corpus_build: Path) -> bytes:
    """The real filing, from the session's corpus build."""
    manifest = json.loads((corpus_build / "manifest.json").read_text(encoding="utf-8"))
    (item,) = [i for i in manifest["sites"]["kestrel"]["items"] if i.get("doc_id") == STUB.stem]
    return (corpus_build / item["file"]["blob"]).read_bytes()


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


def heading(page: Page) -> str:
    first = page[0]
    assert isinstance(first, blocks.Heading)
    return blocks.plain(first.content)


def tables(page: Page) -> list[list[list[str]]]:
    """Each table's body rows, as cell text."""
    return [
        [[blocks.plain(cell) for cell in row] for row in block.rows]
        for block in page
        if isinstance(block, blocks.Table)
    ]


def amount(text: str) -> Decimal:
    """£1,234.56, €1,234.56 or a shortfall in brackets, (£1,234.56)."""
    value = Decimal(re.sub(r"[£€,()]", "", text))
    return -value if text.startswith("(") else value


def number(text: str) -> int:
    return int(text.replace(",", ""))


def test_every_schedule_adds_up(sheets: list[Page]) -> None:
    """Totals equal the sum of the figures shown, to the penny, and each day's safeguarding
    position opens where the last one closed."""
    checked: Counter[str] = Counter()
    closing: dict[str, Decimal] = {}
    for page in sheets:
        title = heading(page)
        if title.startswith("Schedule 3. Own funds requirement"):
            ((emoney, method_d, _, method_b, total, own, surplus, _),) = [
                [amount(r[1]) if r[0] != "Coverage" else Decimal(0) for r in table]
                for table in tables(page)
            ]
            assert method_d == (emoney * Decimal("0.02")).quantize(Decimal("0.01"), ROUND_HALF_UP)
            assert total == method_d + method_b, title
            assert surplus == own - total, title
        elif title.startswith("Schedule 4"):
            balances, flows = tables(page)
            *lines, requirement, resource, excess = (amount(r[1]) for r in balances)
            opening, receipts, payments, close = (amount(cell) for cell in flows[0])
            where = blocks.lines(page[1:2])
            assert sum(lines) == requirement, where
            assert resource - requirement == excess, where
            assert opening + receipts - payments == close == resource, where
            currency = title.rsplit(" ", 1)[1]
            assert closing.get(currency, opening) == opening, where
            closing[currency] = close
        elif title.startswith("Schedule 5."):
            ((*days, total),) = tables(page)
            for column in (1, 3, 4):
                assert sum(number(day[column]) for day in days) == number(total[column]), title
            assert sum(amount(day[2]) for day in days) == amount(total[2]), title
        elif title.startswith("Schedule 6."):
            for kind, _, gross, recovered, net in tables(page)[0]:
                assert amount(gross) - amount(recovered) == amount(net), (title, kind)
        else:
            continue
        checked[title.split(".")[0]] += 1
    # 12 months; 371 business days across GBP and EUR; 53 weeks by product (and by currency
    # for Schedule 5, EUR from January 2026)
    assert checked == {
        "Schedule 3": 12,
        "Schedule 4A": 253,
        "Schedule 4B": 118,
        "Schedule 5": 234,
        "Schedule 6": 159,
    }


def facts() -> dict[int, str]:
    """The source's `## Page N` sections, by page, as one line of text each."""
    text = STUB.read_text(encoding="utf-8")
    found = re.findall(r"^## Page ([\d,]+)\n\n(.+?)(?=^## |\Z)", text, flags=re.M | re.S)
    return {int(n.replace(",", "")): " ".join(body.replace("**", "").split()) for n, body in found}


def row(page: Page, first: str) -> list[str]:
    (found,) = [r for table in tables(page) for r in table if r[0] == first]
    return found


def minutes(start: str, end: str) -> int:
    return (datetime.strptime(end, "%H:%M") - datetime.strptime(start, "%H:%M")).seconds // 60


def test_each_fact_page_agrees_with_its_rows(sheets: list[Page]) -> None:
    notes = facts()
    assert set(notes) == {130, 328, 845, 883, 2417, 2468, 2861}

    page, note = sheets[129], notes[130]
    match = re.search(r"Friday (\d+ \w+ \d{4}), so (£[\d,]+\.\d\d) left (ACB-SG-\d+) twice", note)
    assert match is not None
    lines = list(blocks.lines(page))
    assert f"Position at 17:00 on Friday {match[1]}" in lines
    assert any(line.startswith(f"Account {match[3]},") for line in lines)
    assert amount(row(page, "Excess (shortfall)")[1]) == -amount(match[2])

    page, note = sheets[327], notes[328]
    match = re.search(r"due by 11:00 on \w+ (\d+ \w+ \d{4})", note)
    assert match is not None
    assert "It found no shortfall" in note
    due = datetime.strptime(match[1], "%d %B %Y").date()
    position = max(d for d in filing.business_days(due - timedelta(days=7), due) if d < due)
    lines = list(blocks.lines(page))
    assert f"Position at 17:00 on {filing.weekday(position)}" in lines
    assert any(line.startswith("Account BM-SG-02, Banco Meridional") for line in lines)
    assert amount(row(page, "Excess (shortfall)")[1]) >= 0

    note = notes[845]
    (reference,) = re.findall(r"CMP-\d{4}-\d{5}", note)
    assert "which the firm had not upheld" in note
    assert "Kestrel Accounts customers" in note
    received, product, topic, outcome, redress = row(sheets[844], reference)[1:6]
    assert (product, topic, outcome, amount(redress)) == (
        "Accounts",
        "Fees and charges",
        "Not upheld",
        0,
    )
    charged = re.search(r"between \d+ and (\d+ \w+ \d{4})", note)
    assert charged is not None
    assert datetime.strptime(charged[1], "%d %B %Y") <= datetime.strptime(received, "%d %B %Y")

    note = notes[883]
    match = re.search(r"(MI-\d{4}-\d+)\. On (\d+ \w+ \d{4}), from (\d\d:\d\d) to (\d\d:\d\d)", note)
    assert match is not None
    assert "classified P1" in note
    assert row(sheets[882], match[1])[1:] == [
        match[2],
        "Card authorisation",
        "P1",
        f"{minutes(match[3], match[4])} min",
        "Yes",
    ]

    page, note = sheets[2416], notes[2417]
    match = re.search(r"From (\d\d):(\d\d) to \1:(\d\d) UK time, EUR card payments", note)
    authorised = re.search(r"processed ([\d,]+) authorisations", note)
    assert match is not None
    assert authorised is not None
    assert heading(page) == "Annex A. Kestrel Checkout, EUR: Wednesday 17 June 2026"
    hour = row(page, f"{match[1]}:00 to {match[1]}:59")
    share = (int(match[3]) - int(match[2])) / 60
    assert number(authorised[1]) <= number(hour[1]) * share

    page, note = sheets[2467], notes[2468]
    match = re.search(r"([\d,]+) payouts worth (£[\d,]+\.\d\d)", note)
    assert match is not None
    assert "payroll file" in note
    assert heading(page) == "Annex A. Kestrel Payouts, GBP: Thursday 25 June 2026"
    (hours,) = tables(page)
    assert sum(number(h[1]) for h in hours) >= number(match[1])
    assert sum(amount(h[2]) for h in hours) >= amount(match[2])

    note = notes[2861]
    match = re.search(
        r"Merchant (M-\d+), .+ \(MCC (\d+), ([\w ]+)\), was exited on (\d+ \w+ \d{4})", note
    )
    assert match is not None
    assert "chargeback ratio" in note
    exited = datetime.strptime(match[4], "%d %B %Y").date()
    category, region, event, when, detail = row(sheets[2860], match[1])[1:]
    assert category.startswith(f"{match[2]} ")
    assert (region, event, when) == (match[3], "Exited", filing.short_day(exited))
    assert detail == "Chargeback ratio above limit"


def test_q2_complaints_follow_the_compliance_report(sheets: list[Page]) -> None:
    report = (SOURCES / "legal-compliance-monitoring-q2-2026.md").read_text(encoding="utf-8")
    causes = re.search(r"Main causes in Q2: (.+?)\. ", report)
    received = re.search(r"\| Complaints received \| ([\d,]+) \| ([\d,]+) \|", report)
    assert causes is not None
    assert received is not None
    shares = {
        cause: int(pct)
        for cause, pct in re.findall(r"(?:^|, | and )([a-z ]+?) \((\d+)%\)", causes[1])
    }
    topics = {
        "payout delays": "Payment delay",
        "chargeback disputes": "Chargeback dispute",
        "account closures": "Account closure",
        "fees and pricing": "Fees and charges",
    }
    assert set(shares) == {*topics, "other issues"}

    by_month: dict[str, Counter[str]] = {m: Counter() for m in ("April", "May", "June")}
    for page in sheets:
        title = heading(page)
        month = re.match(r"Schedule 7\. Complaints register: (\w+) 2026", title)
        if month and month[1] in by_month:
            by_month[month[1]].update(r[3] for r in tables(page)[0])
    quarter = sum(by_month.values(), Counter[str]())
    total = sum(quarter.values())
    assert total == number(received[2])
    other = total - sum(quarter[topic] for topic in topics.values())
    counts = {cause: quarter[topic] for cause, topic in topics.items()} | {"other issues": other}
    assert {cause: round(100 * n / total) for cause, n in counts.items()} == shares
    delays = {month: topics["Payment delay"] for month, topics in by_month.items()}
    assert delays["June"] > max(delays["April"], delays["May"])  # "rose in June"


def test_no_sentence_ends_twice(sheets: list[Page]) -> None:
    doubled = [line for page in sheets for line in blocks.lines(page) if ".." in line]
    assert not doubled, doubled[:3]


# The hand-written documents that quote the filing. Every figure they take from it is checked
# against the generated pages, so a change to the generator or its random draws can't move one
# unnoticed: the fact pages and the totals above, and the complaint, safeguarding and incident
# figures below.
REPORT = SOURCES / "legal-compliance-monitoring-q2-2026.md"
BOARD_PACK = SOURCES / "exec-board-pack-2026-07.md"
QUARTERS = {"Q1": ("January", "February", "March"), "Q2": ("April", "May", "June")}


def complaints(sheets: list[Page], quarter: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for page in sheets:
        month = re.match(r"Schedule 7\. Complaints register: (\w+) 2026", heading(page))
        if month and month[1] in QUARTERS[quarter]:
            rows += tables(page)[0]
    return rows


def positions(sheets: list[Page]) -> list[tuple[str, date, dict[str, Decimal]]]:
    """Each daily safeguarding page: its currency, the day and its balance lines."""
    found: list[tuple[str, date, dict[str, Decimal]]] = []
    for page in sheets:
        title = heading(page)
        if title.startswith("Schedule 4"):
            (position,) = blocks.lines(page[1:2])
            when = position.removeprefix("Position at 17:00 on ")
            day = datetime.strptime(when, "%A %d %B %Y").date()
            lines = {r[0].split(":")[0]: amount(r[1]) for r in tables(page)[0]}
            found.append((title.rsplit(" ", 1)[1], day, lines))
    return found


def test_complaint_counts_and_rates_follow_the_compliance_report(sheets: list[Page]) -> None:
    """432 complaints a quarter, 93.5% resolved within 15 business days in Q1 and 96.8% in Q2,
    as the compliance report and the board pack say."""
    report, pack = REPORT.read_text(encoding="utf-8"), BOARD_PACK.read_text(encoding="utf-8")
    received = re.search(r"\| Complaints received \| ([\d,]+) \| ([\d,]+) \|", report)
    resolved = re.search(
        r"\| Resolved within 15 business days \| ([\d.]+)% \| ([\d.]+)% \|", report
    )
    assert received is not None
    assert resolved is not None
    for quarter, count, rate in zip(QUARTERS, received.groups(), resolved.groups(), strict=True):
        rows = complaints(sheets, quarter)
        within = sum(int(r[6]) <= 15 for r in rows)
        assert len(rows) == number(count), quarter
        assert f"{100 * within / len(rows):.1f}" == rate, (quarter, within, len(rows))
    quoted = re.findall(r"([\d.]+)% resolved within 15 business days", report + pack)
    assert len(quoted) == 2
    assert set(quoted) == {resolved[2]}
    assert re.search(rf"\b{received[2]} complaints; {resolved[2]}% resolved", pack)


def test_safeguarding_and_incident_figures_follow_the_compliance_report(
    sheets: list[Page],
) -> None:
    report = REPORT.read_text(encoding="utf-8")
    days = re.search(r"There were (\d+) UK business days in Q2\. All \1 reconciliations", report)
    held = re.search(
        r"At 30 June 2026 .+? held £[\d.]+bn of customer funds: £([\d.]+)bn in GBP and €(\d+)m",
        report,
    )
    reported = re.search(
        r"In Q1 we reported (\w+) incidents to the FCA: (\w+) P1 incidents and major incident "
        r"(MI-\d{4}-\d+) on (\d+ \w+), .+? caused (\d+) minutes",
        report,
    )
    assert days is not None
    assert held is not None
    assert reported is not None
    assert "none showed a shortfall" in report

    found = positions(sheets)
    q2 = [(currency, day, lines) for currency, day, lines in found if day >= date(2026, 4, 1)]
    assert {day for _, day, _ in q2} == set(
        filing.business_days(date(2026, 4, 1), date(2026, 6, 30))
    )
    assert len({day for _, day, _ in q2}) == int(days[1])
    assert all(lines["Excess (shortfall)"] >= 0 for _, _, lines in q2)
    # The one shortfall in the period is breach SG-2025-02 (page 130).
    short = [(c, d) for c, d, lines in found if lines["Excess (shortfall)"] < 0]
    assert short == [("GBP", date(2025, 11, 14))]
    last = {
        currency: lines["Requirement"] for currency, day, lines in found if day == date(2026, 6, 30)
    }
    assert f"{last['GBP'] / 10**9:.2f}" == held[1]
    assert f"{last['EUR'] / 10**6:.0f}" == held[2]

    words = {"four": 4, "five": 5}
    p1 = [
        line.split(" | ")
        for page in sheets
        if heading(page).startswith("Schedule 8. Incident register")
        for line in blocks.lines(page)
        if " | P1 | " in line and "2026 |" in line
    ]
    q1 = [r for r in p1 if datetime.strptime(r[1], "%d %B %Y").month <= 3]
    assert len(q1) == len(p1) == words[reported[1]]
    assert sum(r[0].startswith("INC-") for r in q1) == words[reported[2]]
    (major,) = [r for r in q1 if r[0] == reported[3]]
    assert major[1] == f"{reported[4]} 2026"
    assert major[4] == f"{reported[5]} min"
