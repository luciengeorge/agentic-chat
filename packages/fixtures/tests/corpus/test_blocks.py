import pytest

from ac_fixtures.corpus.blocks import (
    Heading,
    Hidden,
    ListBlock,
    PageBreak,
    Paragraph,
    RenderError,
    Scan,
    Span,
    Table,
    directives,
    lines,
    parse,
)


def test_inline_formatting_becomes_spans() -> None:
    (paragraph,) = parse("Pay **£40** a *day*, code `KP-4031`,\nthen stop.\n")
    assert paragraph == Paragraph(
        (
            Span("Pay "),
            Span("£40", bold=True),
            Span(" a "),
            Span("day", italic=True),
            Span(", code "),
            Span("KP-4031", code=True),
            Span(", then stop."),
        )
    )


def test_tables_keep_their_alignment() -> None:
    (table,) = parse("| Item | Amount |\n|:--|--:|\n| Meals | £35 |\n")
    assert table == Table(
        header=((Span("Item"),), (Span("Amount"),)),
        rows=(((Span("Meals"),), (Span("£35"),)),),
        align=("left", "right"),
    )


def test_lists_nest_and_keep_their_start() -> None:
    (outer, numbered) = parse("- a\n  - b\n\n3. c\n")
    assert isinstance(outer, ListBlock)
    assert isinstance(numbered, ListBlock)
    assert (outer.ordered, numbered.ordered, numbered.start) == (False, True, 3)
    assert isinstance(outer.items[0][1], ListBlock)


def test_directives_become_blocks() -> None:
    body = (
        "# A\n\n<!-- pagebreak -->\n\n<!-- hidden-begin -->\nSecret\n<!-- hidden-end -->\n\n"
        "<!-- scan-begin -->\nSigned\n<!-- scan-end -->\n"
    )
    content = parse(body)
    assert content == (
        Heading(1, (Span("A"),)),
        PageBreak(),
        Hidden((Paragraph((Span("Secret"),)),)),
        Scan((Paragraph((Span("Signed"),)),)),
    )
    assert directives(content) == {"pagebreak", "hidden", "scan"}
    assert list(lines(content)) == ["A", "Secret", "Signed"]


@pytest.mark.parametrize(
    ("body", "problem"),
    [
        ("<div>x</div>\n", "raw HTML"),
        ("Text <b>bold</b>\n", "raw HTML"),
        ("![logo](logo.png)\n", "unsupported inline"),
        ("<!-- hidden-begin -->\nx\n", "never closed"),
        ("<!-- scan-end -->\n", "without"),
        ("<!-- scan-begin -->\n<!-- hidden-begin -->\n", "inside"),
        ("- item\n\n  <!-- pagebreak -->\n", "top level"),
    ],
)
def test_bad_markup_is_refused(body: str, problem: str) -> None:
    with pytest.raises(RenderError, match=problem):
        parse(body)
