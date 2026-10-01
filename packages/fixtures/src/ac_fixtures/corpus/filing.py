"""The regulatory filing: Kestrel Pay's annual return to the FCA, a page per schedule entry.

Every page is generated from the seed. Each `## Page N` section of the source body is added to
the foot of page N, which is how specific facts sit deep in the document; a section must agree
with the generated figures on its page. The last annex, a paginated register, takes whatever
pages are left, so the filing comes to exactly the page count its source asks for.
"""

import random
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from ac_fixtures.corpus import blocks as b

FIRM = "Kestrel Pay Ltd"
FRN = "999901"
PERIOD_START = date(2025, 7, 1)
PERIOD_END = date(2026, 6, 30)
DAYS = (PERIOD_END - PERIOD_START).days + 1
SUBMITTED = date(2026, 9, 15)
PRODUCTS = ("Kestrel Checkout", "Kestrel Accounts", "Kestrel Payouts")
# The EUR safeguarding account opened for UK merchants' EUR balances on this day.
EUR_FROM = date(2026, 1, 12)
UK_BANK_HOLIDAYS = frozenset(
    {
        date(2025, 8, 25),
        date(2025, 12, 25),
        date(2025, 12, 26),
        date(2026, 1, 1),
        date(2026, 4, 3),
        date(2026, 4, 6),
        date(2026, 5, 4),
        date(2026, 5, 25),
    }
)
FRONT_PAGES = 4

_MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

Page = list[b.Block]


def day(d: date) -> str:
    return f"{d.day} {_MONTHS[d.month - 1]} {d.year}"


def short_day(d: date) -> str:
    return f"{d.day} {_MONTHS[d.month - 1][:3]} {d.year}"


def weekday(d: date) -> str:
    return f"{_WEEKDAYS[d.weekday()]} {day(d)}"


def money(value: Decimal | float, symbol: str = "£") -> str:
    return f"{symbol}{value:,.2f}"


def pence(value: float) -> Decimal:
    """`value` rounded to the penny. Figures that add up are rounded first, then summed."""
    return Decimal(value).quantize(Decimal("0.01"), ROUND_HALF_UP)


def count(value: int) -> str:
    return f"{value:,}"


def _h(level: int, text: str) -> b.Heading:
    return b.Heading(level, (b.Span(text),))


def _p(*parts: str | b.Span) -> b.Paragraph:
    return b.Paragraph(tuple(b.Span(p) if isinstance(p, str) else p for p in parts))


def _bold(text: str) -> b.Span:
    return b.Span(text, bold=True)


def _table(header: list[str], rows: list[list[str]], align: str) -> b.Table:
    aligns: dict[str, b.Align] = {"l": "left", "r": "right", "c": "center"}
    return b.Table(
        header=tuple((b.Span(h),) for h in header),
        rows=tuple(tuple((b.Span(c),) if c else () for c in row) for row in rows),
        align=tuple(aligns[a] for a in align),
    )


def _notes(schedule: str) -> b.Paragraph:
    return _p(
        "Notes. Figures are unaudited and stated in pounds sterling unless shown otherwise. "
        "Balances are taken at the 17:00 UK cut-off on each business day. This schedule forms "
        f"part of the annual return of {FIRM} (FRN {FRN}) for the period {day(PERIOD_START)} "
        f"to {day(PERIOD_END)} and should be read with {schedule}."
    )


@dataclass(frozen=True)
class Section:
    code: str
    title: str
    pages: list[Page]


def build(body: str, *, pages: int, seed: int) -> list[b.Block]:
    """The filing's blocks: exactly `pages` pages, separated by page breaks."""
    added = _added(body, pages)
    sections = _sections(seed)
    used = FRONT_PAGES + sum(len(s.pages) for s in sections)
    if pages <= used:
        raise b.RenderError(f"the regulatory filing needs more than {used} pages, not {pages}")
    sections.append(_merchant_register(seed, pages - used))
    every = [*_front(sections), *(page for section in sections for page in section.pages)]
    assert len(every) == pages
    out: list[b.Block] = []
    for number, page in enumerate(every, start=1):
        if number > 1:
            out.append(b.PageBreak())
        out.extend(page)
        out.extend(added.get(number, ()))
    return out


def _added(body: str, pages: int) -> dict[int, Page]:
    """The body's `## Page N` sections; anything before the first one is commentary."""
    added: dict[int, Page] = {}
    current: Page | None = None
    for block in b.parse(body):
        if isinstance(block, b.Heading) and block.level == 2:
            label = b.plain(block.content)
            number = label.removeprefix("Page ").replace(",", "")
            if not label.startswith("Page ") or not number.isdigit():
                raise b.RenderError(f"filing sections are headed '## Page N', not {label!r}")
            if not 1 <= int(number) <= pages or int(number) in added:
                raise b.RenderError(f"filing page {number} is out of range or set twice")
            current = added[int(number)] = []
        elif current is not None:
            current.append(block)
    return added


def _front(sections: list[Section]) -> Iterator[Page]:
    yield [
        _h(1, "Annual Regulatory Return 2026"),
        _p(_bold(f"{FIRM}"), f", an authorised electronic money institution (FRN {FRN})"),
        _p(f"Reporting period: {day(PERIOD_START)} to {day(PERIOD_END)}"),
        _p(f"Submitted to the Financial Conduct Authority on {day(SUBMITTED)}"),
        _table(
            ["Item", "Detail"],
            [
                ["Registered office", "12 Harrow Yard, London EC2A 4PN, United Kingdom"],
                [
                    "Scope",
                    f"{FIRM} only; Kestrel Pay Europe Ltd reports to the Central Bank of Ireland",
                ],
                ["Prepared by", "Legal and Compliance"],
                ["Regulatory contact", "Sofia Lindqvist, Compliance Officer"],
                ["Legal contact", "Helen Marsh, General Counsel"],
                ["Classification", "Confidential: submitted under FSMA 2000, section 165"],
            ],
            "ll",
        ),
    ]
    start = FRONT_PAGES + 1
    rows: list[list[str]] = []
    for section in sections:
        end = start + len(section.pages) - 1
        rows.append([section.code, section.title, f"{start:,} to {end:,}"])
        start = end + 1
    front = [["", "Cover", "1"], ["", "Contents", "2"], ["", "Abbreviations", "3"]]
    yield [
        _h(2, "Contents"),
        _table(["Part", "Title", "Pages"], [*front, ["", "Declaration", "4"], *rows], "llr"),
    ]
    yield [
        _h(2, "Abbreviations"),
        _table(
            ["Term", "Meaning"],
            [
                ["APP", "Authorised push payment"],
                ["CET1", "Common equity tier 1 capital"],
                ["EDD", "Enhanced due diligence"],
                ["EMI", "Electronic money institution"],
                ["EMRs", "Electronic Money Regulations 2011"],
                ["FOS", "Financial Ombudsman Service"],
                ["FRN", "Firm reference number"],
                ["MCC", "Merchant category code"],
                ["PSRs", "Payment Services Regulations 2017"],
                ["SMF", "Senior management function"],
                ["Relevant funds", "Funds received from or for customers that must be safeguarded"],
            ],
            "ll",
        ),
    ]
    yield [
        _h(2, "Declaration"),
        _p(
            f"We confirm that this return has been prepared in accordance with the Electronic "
            f"Money Regulations 2011, the Payment Services Regulations 2017 and the reporting "
            f"rules in SUP 16. To the best of our knowledge and belief, the information in this "
            f"return is complete and accurate, and {FIRM} met its safeguarding and capital "
            f"requirements throughout the reporting period, except as disclosed in Part 4 and "
            f"Schedule 8."
        ),
        _p(
            "The board approved this return on 9 September 2026. Where a figure in a schedule "
            "differs from the audited financial statements for the year ended 31 December "
            "2025, the schedule explains the difference."
        ),
        _table(
            ["Signed for the firm", "Role", "Date"],
            [
                ["Amara Okafor", "Chief Executive Officer (SMF1)", day(date(2026, 9, 9))],
                ["Daniel Reyes", "Chief Financial Officer (SMF2)", day(date(2026, 9, 9))],
                ["Sofia Lindqvist", "Compliance Officer (SMF16, SMF17)", day(date(2026, 9, 9))],
            ],
            "lll",
        ),
    ]


def _sections(seed: int) -> list[Section]:
    return [
        Section("1", "Firm information", _firm()),
        Section("2", "Governance and senior managers", _governance()),
        Section("3", "Capital adequacy", _capital(seed)),
        Section("4", "Safeguarding of relevant funds", _safeguarding(seed)),
        Section("5", "Payment transactions by product and region", _transactions(seed)),
        Section("6", "Fraud reporting", _fraud(seed)),
        Section("7", "Complaints", _complaints(seed)),
        Section("8", "Operational and security incidents", _incidents(seed)),
        Section("9", "Outsourcing and third parties", _outsourcing()),
        Section("A", "Annex A: daily transaction statistics", _daily(seed)),
    ]


def _firm() -> list[Page]:
    return [
        [
            _h(2, "Part 1. Firm information"),
            _h(3, "1.1 Firm details"),
            _table(
                ["Field", "Value"],
                [
                    ["Legal name", FIRM],
                    ["Company number", "10873215"],
                    ["Firm reference number", FRN],
                    ["Status", "Authorised electronic money institution"],
                    ["Incorporated", "England and Wales, 2017"],
                    ["Financial year end", "31 December"],
                    ["Reporting currency", "GBP"],
                    ["Group revenue, year ended 31 December 2025", "£138.4m"],
                    ["Group merchant customers at 30 June 2026", "48,210"],
                    ["Business accounts open at 30 June 2026", "30,600"],
                    ["Customer funds safeguarded at 30 June 2026", "£1.02bn (group £1.24bn)"],
                    ["Group employees at 30 June 2026", "589"],
                ],
                "ll",
            ),
            _p(
                f"{FIRM} provides card acceptance, business current accounts and supplier and "
                "payroll payouts to small and medium businesses. It holds no agents and uses no "
                "distributors of electronic money."
            ),
        ],
        [
            _h(3, "1.2 Group structure, offices and headcount"),
            _p(
                "Kestrel Pay Europe Ltd, the group's Irish subsidiary, serves EU merchants under "
                "its own authorisation from the Central Bank of Ireland and is outside this "
                "return. Group figures are given where the FCA asks for them."
            ),
            _table(
                ["Office", "Role", "Employees at 30 June 2026"],
                [
                    ["London", "Head office, all functions", "334"],
                    ["Lisbon", "Engineering, operations and customer support", "168"],
                    ["Dublin", "Kestrel Pay Europe Ltd", "73"],
                    ["Remote (UK)", "", "14"],
                    ["Total", "", "589"],
                ],
                "llr",
            ),
        ],
        [
            _h(3, "1.3 Products"),
            _table(
                ["Product", "Service", "Regulated activity"],
                [
                    ["Kestrel Checkout", "Card acceptance", "Acquiring of payment transactions"],
                    ["Kestrel Accounts", "Business current accounts", "Issuing e-money"],
                    ["Kestrel Payouts", "Supplier and payroll payouts", "Money remittance"],
                ],
                "lll",
            ),
            _p(
                "No new product was launched in the reporting period. From 12 January 2026 UK "
                "merchants can hold EUR balances in Kestrel Accounts."
            ),
        ],
        [
            _h(3, "1.4 Changes in the reporting period"),
            _p(
                "There was no change in control and no change to the firm's permissions. The "
                "firm appointed Fernside & Co LLP as its safeguarding auditor in October 2025 "
                "and notified the FCA on 14 October 2025."
            ),
        ],
    ]


def _governance() -> list[Page]:
    return [
        [
            _h(2, "Part 2. Governance and senior managers"),
            _h(3, "2.1 Senior managers"),
            _table(
                ["Name", "Function", "Since"],
                [
                    ["Amara Okafor", "SMF1 Chief Executive", day(date(2017, 5, 2))],
                    ["Daniel Reyes", "SMF2 Chief Finance", day(date(2021, 1, 11))],
                    ["Sofia Lindqvist", "SMF16 Compliance Oversight", day(date(2023, 4, 3))],
                    ["Sofia Lindqvist", "SMF17 Money Laundering Reporting", day(date(2023, 4, 3))],
                    ["Priya Nair", "SMF24 Chief Operations", day(date(2022, 9, 5))],
                ],
                "lll",
            ),
        ],
        [
            _h(3, "2.2 Board and committees"),
            _table(
                ["Body", "Chair", "Meetings in period"],
                [
                    ["Board", "Independent chair", "9"],
                    ["Audit and Risk Committee", "Independent director", "6"],
                    ["Safeguarding Committee", "Daniel Reyes", "12"],
                    ["Financial Crime Committee", "Sofia Lindqvist", "12"],
                ],
                "llr",
            ),
        ],
        [
            _h(3, "2.3 Responsibility for this return"),
            _p(
                "Helen Marsh, General Counsel, owns the preparation of this return. Sofia "
                "Lindqvist reviews the safeguarding, fraud and complaints schedules, and Tom "
                "Whitfield, Financial Controller, prepares the capital and safeguarding figures."
            ),
        ],
        [
            _h(3, "2.4 Training"),
            _p(
                "All staff completed the annual financial crime and safeguarding training by "
                "31 March 2026. Completion was 99.2%; the remaining staff were on long-term leave."
            ),
        ],
    ]


def _months() -> Iterator[date]:
    for i in range(12):
        yield date(PERIOD_START.year + (PERIOD_START.month - 1 + i) // 12, (6 + i) % 12 + 1, 1)


def _method_b(volume: Decimal) -> Decimal:
    """The PSRs 2017 Method B requirement on monthly payment volume, scaling factor 1."""
    tiers = (
        (5_000_000, "0.04"),
        (5_000_000, "0.025"),
        (90_000_000, "0.01"),
        (150_000_000, "0.005"),
        (None, "0.0025"),
    )
    need, rest = Decimal(0), volume
    for size, rate in tiers:
        part = rest if size is None else min(rest, Decimal(size))
        need += part * Decimal(rate)
        rest -= part
    return need.quantize(Decimal("0.01"), ROUND_HALF_UP)


OWN_FUNDS = Decimal("61314110.00")


def _capital(seed: int) -> list[Page]:
    rng = random.Random(f"{seed}:capital")
    pages: list[Page] = [
        [
            _h(2, "Part 3. Capital adequacy"),
            _p(
                "The firm calculates its own funds requirement for issuing e-money under "
                "Method D (2% of average outstanding e-money) and, for payment services not "
                "related to e-money, under Method B on its monthly payment volume. Own funds "
                "are common equity tier 1 capital only."
            ),
        ],
        [
            _h(3, "3.1 Own funds at 30 June 2026"),
            _table(
                ["Component", "Amount"],
                [
                    ["Share capital and premium", "£52,000,000.00"],
                    ["Retained earnings", "£14,826,410.00"],
                    ["Less intangible assets", "(£5,512,300.00)"],
                    ["Common equity tier 1", money(OWN_FUNDS)],
                ],
                "lr",
            ),
        ],
        [
            _h(3, "3.2 Stress testing"),
            _p(
                "The board's capital stress test assumes a 30% fall in revenue over two "
                "quarters and a single operational loss of £4m. Own funds stay above the "
                "requirement in every scenario."
            ),
        ],
        [
            _h(3, "3.3 Wind-down plan"),
            _p(
                "The wind-down plan was refreshed in January 2026. It sets aside £9.5m to "
                "return relevant funds and close the business over nine months."
            ),
        ],
    ]
    for i, month in enumerate(_months()):
        emoney = pence((590e6 + 120e6 * i / 11) * rng.uniform(0.98, 1.02))
        volume = pence((1.72e9 + 0.3e9 * i / 11) * rng.uniform(0.97, 1.03))
        method_d = (emoney * Decimal("0.02")).quantize(Decimal("0.01"), ROUND_HALF_UP)
        method_b = _method_b(volume)
        own = OWN_FUNDS if i == 11 else pence((55.2e6 + 5.6e6 * i / 11) * rng.uniform(0.995, 1.005))
        need = method_d + method_b
        pages.append(
            [
                _h(
                    3, f"Schedule 3. Own funds requirement: {_MONTHS[month.month - 1]} {month.year}"
                ),
                _table(
                    ["Line", "Amount"],
                    [
                        ["Average outstanding e-money", money(emoney)],
                        ["Method D requirement (2%)", money(method_d)],
                        ["Monthly payment volume, Checkout and Payouts", money(volume)],
                        ["Method B requirement", money(method_b)],
                        ["Total own funds requirement", money(need)],
                        ["Own funds (CET1)", money(own)],
                        ["Surplus", money(own - need)],
                        ["Coverage", f"{own / need:.2f}x"],
                    ],
                    "lr",
                ),
                _notes("Part 3"),
            ]
        )
    return pages


@dataclass(frozen=True)
class _Account:
    code: str
    bank: str
    currency: str
    symbol: str
    opened: date
    # (line, balance at 30 June 2026) making up the safeguarding requirement
    requirement: tuple[tuple[str, float], ...]


_ACCOUNTS = (
    _Account(
        "ACB-SG-01",
        "Albion Clearing Bank",
        "GBP",
        "£",
        PERIOD_START,
        (
            ("E-money outstanding: Kestrel Accounts", 565e6),
            ("E-money outstanding: Payouts wallets", 150e6),
            ("Checkout settlements in transit", 218e6),
        ),
    ),
    _Account(
        "BM-SG-02",
        "Banco Meridional, S.A.",
        "EUR",
        "\u20ac",
        EUR_FROM,
        (
            ("E-money outstanding: Kestrel Accounts", 56e6),
            ("E-money outstanding: Payouts wallets", 14e6),
            ("Checkout settlements in transit", 25e6),
        ),
    ),
)
# The safeguarding breach SG-2025-02: a Payouts file paid twice from ACB-SG-01.
_SHORTFALLS = {("GBP", date(2025, 11, 14)): Decimal("1284316.40")}


def business_days(start: date, end: date) -> Iterator[date]:
    d = start
    while d <= end:
        if d.weekday() < 5 and d not in UK_BANK_HOLIDAYS:
            yield d
        d += timedelta(days=1)


def _signed(value: Decimal, symbol: str) -> str:
    return money(value, symbol) if value >= 0 else f"({money(-value, symbol)})"


def _safeguarding(seed: int) -> list[Page]:
    pages: list[Page] = [
        [
            _h(2, "Part 4. Safeguarding of relevant funds"),
            _p(
                "The firm safeguards relevant funds by segregation, in designated safeguarding "
                "accounts that the banks have acknowledged in writing: ACB-SG-01 at Albion "
                "Clearing Bank for GBP, and BM-SG-02 at Banco Meridional, S.A. for EUR, opened "
                "on 12 January 2026 for UK merchants' EUR balances. Funds received for "
                "customers reach a safeguarding account by the end of the business day after "
                "receipt."
            ),
            _p(
                "At 30 June 2026 the firm held £1.02bn of customer funds: £0.94bn in GBP and "
                "\u20ac95m (about £0.08bn) in EUR."
            ),
        ],
        [
            _h(3, "4.1 Reconciliation"),
            _p(
                "Every UK business day, by 11:00, Treasury Operations compares the requirement "
                "(e-money outstanding plus Checkout settlements in transit) with the resource "
                "(cleared balances on the safeguarding accounts) for each currency, as at the "
                "17:00 cut-off on the previous business day. Any shortfall is topped up from "
                "the firm's own funds by 12:00. Since March 2026 Treasury Operations also checks "
                "at 15:00 that each bank's statement file has arrived."
            ),
        ],
        [
            _h(3, "4.2 Safeguarding audit"),
            _p(
                "Fernside & Co LLP completed the annual safeguarding audit for the year ended "
                "31 December 2025 on 27 March 2026 with a reasonable assurance opinion and two "
                "low-rated findings, both closed by 30 April 2026. The FCA's new safeguarding "
                "rules applied from 7 May 2026; the firm has submitted a monthly safeguarding "
                "return since May 2026."
            ),
        ],
        [
            _h(3, "4.3 Breaches"),
            _p(
                "Two safeguarding breaches occurred in the period, SG-2025-02 and SG-2026-01. "
                "Each is described on the reconciliation page for the position it affected, in "
                "Schedules 4A and 4B."
            ),
        ],
    ]
    for code, account in zip(("4A", "4B"), _ACCOUNTS, strict=True):
        rng = random.Random(f"{seed}:safeguarding:{account.currency}")
        days = list(business_days(account.opened, PERIOD_END))
        closing: Decimal | None = None
        for i, d in enumerate(days):
            # Customer funds grew through the period, to the 30 June 2026 balances.
            growth = (
                0.8 + 0.2 * i / (len(days) - 1)
                if account.currency == "GBP"
                else (0.3 + 0.7 * i / (len(days) - 1))
            )
            lines = [
                (label, pence(end * growth * rng.uniform(0.97, 1.03)))
                for label, end in account.requirement
            ]
            requirement = sum((value for _, value in lines), Decimal(0))
            shortfall = _SHORTFALLS.get((account.currency, d))
            excess = -shortfall if shortfall else pence(rng.uniform(40e3, 900e3))
            resource = requirement + excess
            opening = (
                closing if closing is not None else pence(float(resource) * rng.uniform(0.98, 1.02))
            )
            receipts = pence(float(requirement) * rng.uniform(0.18, 0.3))
            payments = opening + receipts - resource
            closing = resource
            sym = account.symbol
            pages.append(
                [
                    _h(
                        3, f"Schedule {code}. Daily safeguarding reconciliation, {account.currency}"
                    ),
                    _p(_bold(f"Position at 17:00 on {weekday(d)}")),
                    _p(f"Account {account.code}, {account.bank.removesuffix('.')}."),
                    _table(
                        ["Line", "Amount"],
                        [
                            *[[label, money(value, sym)] for label, value in lines],
                            ["Requirement", money(requirement, sym)],
                            [f"Resource: cleared balance on {account.code}", money(resource, sym)],
                            ["Excess (shortfall)", _signed(excess, sym)],
                        ],
                        "lr",
                    ),
                    _table(
                        ["Opening balance", "Receipts", "Payments", "Closing balance"],
                        [
                            [
                                money(opening, sym),
                                money(receipts, sym),
                                money(payments, sym),
                                money(closing, sym),
                            ]
                        ],
                        "rrrr",
                    ),
                    _p("Prepared by Treasury Operations. Reviewed by Tom Whitfield."),
                    _notes("Part 4"),
                ]
            )
    return pages


# (currency, symbol, share of value, first day)
_CURRENCIES = (("GBP", "£", 0.93, PERIOD_START), ("EUR", "\u20ac", 0.07, EUR_FROM))
# A weekday's value in GBP; a weekend day is 45% of it.
_DAILY_VALUE = {"Kestrel Checkout": 53.5e6, "Kestrel Accounts": 28e6, "Kestrel Payouts": 19.6e6}
_AVERAGE = {"Kestrel Checkout": 47.0, "Kestrel Accounts": 512.0, "Kestrel Payouts": 268.0}


def _weeks() -> Iterator[tuple[date, list[date]]]:
    """Calendar weeks (Monday to Sunday) touching the period, each with its days in the period."""
    start = PERIOD_START - timedelta(days=PERIOD_START.weekday())
    while start <= PERIOD_END:
        week = [start + timedelta(days=offset) for offset in range(7)]
        yield start, [d for d in week if PERIOD_START <= d <= PERIOD_END]
        start += timedelta(weeks=1)


def _partial(days: list[date]) -> list[b.Block]:
    if len(days) == 7:
        return []
    return [
        _p(
            f"This week runs past the reporting period, so it covers only {day(days[0])} "
            f"to {day(days[-1])}."
        )
    ]


def _transactions(seed: int) -> list[Page]:
    rng = random.Random(f"{seed}:transactions")
    pages: list[Page] = []
    for start, week in _weeks():
        for product in PRODUCTS:
            for currency, symbol, share, first in _CURRENCIES:
                days = [d for d in week if d >= first]
                if not days:
                    continue
                rate = 1.0 if currency == "GBP" else 1.16
                rows: list[list[str]] = []
                numbers, values, declines, refunded = 0, Decimal(0), 0, 0
                for d in days:
                    weekend = 0.45 if d.weekday() >= 5 else 1.0
                    raw = _DAILY_VALUE[product] * share * rate * weekend * rng.uniform(0.85, 1.15)
                    number = int(raw / (_AVERAGE[product] * rate * rng.uniform(0.9, 1.1)))
                    declined = int(number * rng.uniform(0.012, 0.035))
                    refunds = int(number * rng.uniform(0.002, 0.008))
                    value = pence(raw)
                    numbers += number
                    values += value
                    declines += declined
                    refunded += refunds
                    rows.append(
                        [
                            weekday(d),
                            count(number),
                            money(value, symbol),
                            count(declined),
                            count(refunds),
                        ]
                    )
                rows.append(
                    [
                        "Week total",
                        count(numbers),
                        money(values, symbol),
                        count(declines),
                        count(refunded),
                    ]
                )
                pages.append(
                    [
                        _h(3, f"Schedule 5. {product}, {currency}: week commencing {day(start)}"),
                        _table(
                            ["Day", "Transactions", "Value", "Declined", "Refunds"],
                            rows,
                            "lrrrr",
                        ),
                        *_partial(days),
                        _notes("Part 5"),
                    ]
                )
    return pages


_FRAUD_TYPES = {
    "Kestrel Checkout": (
        "Card not present",
        "Lost or stolen card",
        "Counterfeit card",
        "Merchant collusion",
        "Refund abuse",
    ),
    "Kestrel Accounts": (
        "Authorised push payment",
        "Account takeover",
        "Money mule activity",
        "First-party fraud",
        "Cheque and paper fraud",
    ),
    "Kestrel Payouts": (
        "Payee manipulation",
        "Invoice redirection",
        "Account takeover",
        "Insider fraud",
        "Duplicate payout",
    ),
}


def _fraud(seed: int) -> list[Page]:
    rng = random.Random(f"{seed}:fraud")
    pages: list[Page] = []
    for start, days in _weeks():
        for product in PRODUCTS:
            rows: list[list[str]] = []
            for kind in _FRAUD_TYPES[product]:
                cases = rng.randint(0, 60)
                if kind == "Card not present" and start.year == 2026 and start.month == 4:
                    cases *= 4  # the April 2026 card-testing attacks
                value = pence(cases * rng.uniform(120, 1900))
                recovered = pence(float(value) * rng.uniform(0.1, 0.6))
                rows.append(
                    [kind, count(cases), money(value), money(recovered), money(value - recovered)]
                )
            pages.append(
                [
                    _h(3, f"Schedule 6. Fraud, {product}: week commencing {day(start)}"),
                    _table(
                        ["Fraud type", "Cases", "Gross loss", "Recovered", "Net loss"],
                        rows,
                        "lrrrr",
                    ),
                    _p(
                        "Cases are counted in the week they were confirmed. Losses borne by "
                        "merchants under chargeback rules are excluded."
                    ),
                    *_partial(days),
                    _notes("Part 6"),
                ]
            )
    return pages


_COMPLAINT_TOPICS = (
    "Payment delay",
    "Chargeback dispute",
    "Account closure",
    "Fees and charges",
    "Service quality",
    "Fraud and scams",
    "Onboarding decision",
)

# Compliance's Q2 2026 monitoring report gives the quarter's mix of 432 complaints: payout
# delays 31%, chargeback disputes 22%, account closures 14%, fees and pricing 11% and other
# issues 22%, with payout delays rising in June. The register matches it exactly. Counts per
# month, in _COMPLAINT_TOPICS order.
_Q2_2026_TOPICS = {
    date(2026, 4, 1): (40, 32, 20, 16, 12, 12, 12),
    date(2026, 5, 1): (42, 32, 20, 16, 11, 12, 11),
    date(2026, 6, 1): (52, 31, 20, 16, 9, 8, 8),
}

# The complaint the Financial Ombudsman Service later decided against the firm (see the source).
_FIXED_COMPLAINTS = {
    1171: (date(2026, 3, 14), "Accounts", "Fees and charges", "Not upheld", Decimal(0), 8),
}


def _complaints(seed: int) -> list[Page]:
    rng = random.Random(f"{seed}:complaints")
    pages: list[Page] = []
    number = 0
    for month in _months():
        mix = _Q2_2026_TOPICS.get(month)
        topics = [
            topic
            for topic, n in zip(
                _COMPLAINT_TOPICS, mix or (0,) * len(_COMPLAINT_TOPICS), strict=True
            )
            for _ in range(n)
        ]
        # Shuffled on a stream of its own, so the register's stream draws what it always has.
        random.Random(f"{seed}:complaints:{month}").shuffle(topics)
        for sheet in range(6):
            rows: list[list[str]] = []
            for _ in range(24):
                number += 1
                received = month + timedelta(days=rng.randint(0, 27))
                # About 96% are resolved within 15 business days, as Compliance reports.
                days = rng.randint(1, 15) if rng.random() < 0.96 else rng.randint(16, 35)
                outcome = rng.choice(("Upheld", "Not upheld", "Partly upheld"))
                redress = pence(rng.uniform(25, 950)) if outcome != "Not upheld" else Decimal(0)
                product = rng.choice(PRODUCTS).removeprefix("Kestrel ")
                drawn = rng.choice(_COMPLAINT_TOPICS)  # drawn even when the mix decides
                topic = topics.pop() if mix else drawn
                if number in _FIXED_COMPLAINTS:
                    received, product, topic, outcome, redress, days = _FIXED_COMPLAINTS[number]
                rows.append(
                    [
                        f"CMP-{received.year}-{number:05d}",
                        day(received),
                        product,
                        topic,
                        outcome,
                        money(redress),
                        str(days),
                    ]
                )
            title = f"{_MONTHS[month.month - 1]} {month.year}, sheet {sheet + 1} of 6"
            pages.append(
                [
                    _h(3, f"Schedule 7. Complaints register: {title}"),
                    _table(
                        [
                            "Reference",
                            "Received",
                            "Product",
                            "Topic",
                            "Outcome",
                            "Redress",
                            "Business days",
                        ],
                        rows,
                        "lllllrr",
                    ),
                    _notes("Part 7"),
                ]
            )
    return pages


_SYSTEMS = (
    "Card authorisation",
    "Faster Payments gateway",
    "SEPA gateway",
    "Merchant dashboard",
    "Payouts batch engine",
    "Identity verification",
    "Open banking API",
)


# Q1 2026's P1 incidents, as Compliance reported them: four, plus major incident MI-2026-03.
_P1_2026 = (
    (date(2026, 1, 14), "Faster Payments gateway", 52, None),
    (date(2026, 2, 6), "Card authorisation", 41, "MI-2026-03"),
    (date(2026, 2, 23), "Payouts batch engine", 74, None),
    (date(2026, 3, 9), "Open banking API", 38, None),
    (date(2026, 3, 27), "SEPA gateway", 61, None),
)
_INCIDENT_SHEETS = 23
_INCIDENTS_PER_SHEET = 20


def _incidents(seed: int) -> list[Page]:
    """The register in detection order. References carry the detection date, as in
    INC-2026-0817, with -2, -3 for later incidents that day. P1s are rare in 2025, and in
    2026 they are exactly the ones in _P1_2026."""
    rng = random.Random(f"{seed}:incidents")
    total = _INCIDENT_SHEETS * _INCIDENTS_PER_SHEET
    found: list[tuple[date, str, str, int, str | None]] = []
    for _ in range(total - len(_P1_2026)):
        detected = PERIOD_START + timedelta(days=rng.randint(0, DAYS - 1))
        weights = (1, 6, 30) if detected.year == 2025 else (0, 6, 30)
        severity = rng.choices(("P1", "P2", "P3"), weights=weights)[0]
        minutes = rng.randint(4, 240 if severity != "P3" else 90)
        found.append((detected, rng.choice(_SYSTEMS), severity, minutes, None))
    found += [(d, system, "P1", minutes, ref) for d, system, minutes, ref in _P1_2026]
    found.sort(key=lambda incident: incident[0])
    on_day: dict[date, int] = {}
    rows: list[list[str]] = []
    for detected, system, severity, minutes, ref in found:
        if ref is None:
            on_day[detected] = on_day.get(detected, 0) + 1
            ref = f"INC-{detected:%Y-%m%d}" + (
                f"-{on_day[detected]}" if on_day[detected] > 1 else ""
            )
        reported = "Yes" if severity == "P1" else "No"
        rows.append([ref, day(detected), system, severity, f"{minutes} min", reported])
    pages: list[Page] = [
        [
            _h(2, "Part 8. Operational and security incidents"),
            _p(
                "The register lists every incident rated P1 to P3, in the order they were "
                "detected. P1 incidents and major operational or security incidents were "
                "reported to the FCA under the incident reporting rules within four hours of "
                "classification. There were no P1 incidents in April, May or June 2026."
            ),
        ]
    ]
    for sheet in range(_INCIDENT_SHEETS):
        chunk = rows[sheet * _INCIDENTS_PER_SHEET : (sheet + 1) * _INCIDENTS_PER_SHEET]
        pages.append(
            [
                _h(3, f"Schedule 8. Incident register, sheet {sheet + 1} of {_INCIDENT_SHEETS}"),
                _table(
                    ["Reference", "Detected", "System", "Severity", "Duration", "Reported"],
                    chunk,
                    "llllrl",
                ),
                _notes("Part 8"),
            ]
        )
    return pages


def _outsourcing() -> list[Page]:
    arrangements = [
        ["Cloud hosting, primary: Ashgrove Cloud Services Ltd (AWS eu-west-2)", "Material",
         "United Kingdom", "2029"],
        ["Cloud hosting, disaster recovery: Ashgrove Cloud Services Ltd (AWS eu-west-1)",
         "Material", "Ireland", "2029"],
        ["Card acquiring and processing: Northbridge Acquiring Ltd", "Material",
         "United Kingdom", "2029"],
        ["Secondary card acquiring: Corvane Payments Ltd", "Material", "United Kingdom", "2027"],
        ["Faster Payments sponsor bank: Albion Clearing Bank plc", "Material", "United Kingdom",
         "No fixed end"],
        ["SEPA access: Banco Meridional, S.A.", "Material", "Portugal", "No fixed end"],
        ["Identity verification: Sorrel Identity Ltd", "Material", "United Kingdom", "2027"],
        ["Sanctions screening", "Material", "United Kingdom", "2027"],
        ["Customer support platform: Helmsley Support Software Ltd", "Non-material",
         "United Kingdom", "2027"],
        ["Payroll bureau: Oakmere Payroll Services Ltd", "Non-material", "United Kingdom",
         "2027"],
        ["Document storage", "Non-material", "Ireland", "2028"],
    ]  # fmt: skip
    return [
        [
            _h(2, "Part 9. Outsourcing and third parties"),
            _table(
                ["Arrangement", "Materiality", "Location", "Contract ends"], arrangements, "llll"
            ),
        ],
        [
            _h(3, "9.1 Changes and exit plans"),
            _p(
                "Ashgrove Cloud Services took over the running of the AWS production "
                "environment on 1 April 2026. The firm notified the FCA of this material "
                "outsourcing on 20 February 2026. Every material arrangement has an exit "
                "plan; the failover to the disaster recovery region was last tested on "
                "9 May 2026."
            ),
        ],
    ]


_HOURS = [f"{h:02d}:00 to {h:02d}:59" for h in range(24)]


def _daily(seed: int) -> list[Page]:
    rng = random.Random(f"{seed}:daily")
    pages: list[Page] = []
    for i in range(DAYS):
        d = PERIOD_START + timedelta(days=i)
        for product in PRODUCTS:
            for currency, symbol, share, first in _CURRENCIES:
                if d < first:
                    continue
                rate = 1.0 if currency == "GBP" else 1.16
                weekend = 0.45 if d.weekday() >= 5 else 1.0
                rows: list[list[str]] = []
                for hour in range(24):
                    curve = 0.25 + (0.75 if 8 <= hour <= 19 else 0.0)
                    value = (
                        _DAILY_VALUE[product] * share * rate / 15 * weekend * curve
                    ) * rng.uniform(0.8, 1.2)
                    number = int(value / (_AVERAGE[product] * rate))
                    rows.append(
                        [
                            _HOURS[hour],
                            count(number),
                            money(value, symbol),
                            count(int(number * 0.02)),
                        ]
                    )
                pages.append(
                    [
                        _h(3, f"Annex A. {product}, {currency}: {weekday(d)}"),
                        _table(
                            ["Hour (UK time)", "Transactions", "Value", "Declined"], rows, "lrrr"
                        ),
                        _notes("Part 5"),
                    ]
                )
    return pages


_MCC = (
    ("5812", "Restaurants"),
    ("5411", "Grocery stores"),
    ("7230", "Hair and beauty"),
    ("5732", "Electronics"),
    ("5999", "Specialty retail"),
    ("7299", "Personal services"),
    ("4121", "Taxis"),
    ("8099", "Health services"),
    ("5691", "Clothing"),
    ("7011", "Hotels"),
)
_REGIONS_UK = (
    "London",
    "London",
    "South East",
    "North West",
    "Midlands",
    "Scotland",
    "Yorkshire",
    "South West",
    "Wales",
    "Northern Ireland",
)
_ONBOARDED = ("Approved", "Approved", "Approved", "Approved after EDD")
_EXITED = (
    "Merchant request",
    "Business closed",
    "Inactive for 12 months",
    "Chargeback ratio above limit",
    "Failed periodic review",
    "Moved to another provider",
)


def _merchant_register(seed: int, pages: int) -> Section:
    rng = random.Random(f"{seed}:merchants")
    out: list[Page] = []
    merchant = 200000
    for sheet in range(pages):
        rows: list[list[str]] = []
        for _ in range(24):
            merchant += rng.randint(1, 4)
            mcc, category = rng.choice(_MCC)
            when = PERIOD_START + timedelta(days=rng.randint(0, DAYS - 1))
            joined = rng.random() < 0.6
            rows.append(
                [
                    f"M-{merchant}",
                    f"{mcc} {category}",
                    rng.choice(_REGIONS_UK),
                    "Onboarded" if joined else "Exited",
                    short_day(when),
                    rng.choice(_ONBOARDED if joined else _EXITED),
                ]
            )
        out.append(
            [
                _h(3, f"Annex B. Merchant movements register, sheet {sheet + 1:,} of {pages:,}"),
                _table(
                    ["Merchant", "Category", "Region", "Event", "Date", "Detail"], rows, "llllll"
                ),
                _notes("Part 1"),
            ]
        )
    return Section("B", "Annex B: merchant movements register", out)
