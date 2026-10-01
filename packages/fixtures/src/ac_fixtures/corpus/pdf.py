"""Blocks to PDF with reportlab: a text layer, real (ruled) tables, and a fixed page order."""

import io
import math
import os
import re
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from functools import cache
from pathlib import Path
from typing import Any, Literal, cast
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    Image,
    Indenter,
    ListFlowable,
    ListItem,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.doctemplate import LayoutError

from ac_core.slots import find_repo_root
from ac_fixtures.corpus import blocks as b

PAGE_W, PAGE_H = A4
MARGIN = 20 * mm
FOOTER_Y = 11 * mm
CELL_PAD = 4
# A table's font shrinks to no less than this share of the body size to fit its words.
MIN_TABLE_SCALE = 0.7
# Room past a cell's longest word, so rounding can't push it over the line and split it.
_SLACK = 0.01
HAND_FONT = "Kalam-Regular"
HEADER_FILL = colors.Color(0.9, 0.9, 0.9)
# reportlab's TA_LEFT, TA_CENTER and TA_RIGHT; its paragraphs mis-draw the string forms.
_ALIGNMENT: dict[b.Align, Literal[0, 1, 2]] = {"left": 0, "center": 1, "right": 2}


@dataclass(frozen=True)
class Images:
    """Pre-rendered page images (JPEG), one full page each, with no text layer."""

    pages: tuple[bytes, ...]


Content = b.Block | Images


@dataclass(frozen=True)
class Look:
    regular: str
    bold: str
    italic: str
    bold_italic: str
    mono: str
    size: float
    leading: float
    footer: bool

    @property
    def hand(self) -> bool:
        return self.regular == HAND_FONT


PRINT = Look(
    regular="Helvetica",
    bold="Helvetica-Bold",
    italic="Helvetica-Oblique",
    bold_italic="Helvetica-BoldOblique",
    mono="Courier",
    size=10,
    leading=13.5,
    footer=True,
)
PRINT_PLAIN = replace(PRINT, footer=False)
HAND = Look(
    regular=HAND_FONT,
    bold=HAND_FONT,
    italic=HAND_FONT,
    bold_italic=HAND_FONT,
    mono=HAND_FONT,
    size=13,
    leading=20,
    footer=False,
)


@dataclass(frozen=True)
class Pdf:
    data: bytes
    pages: int


def font_path() -> Path:
    return find_repo_root() / "fixtures" / "corpus" / "fonts" / f"{HAND_FONT}.ttf"


@cache
def _hand_glyphs() -> frozenset[str]:
    font = TTFont(HAND_FONT, str(font_path()))
    pdfmetrics.registerFont(font)  # pyright: ignore[reportUnknownMemberType]
    return frozenset(chr(code) for code in font.face.charToGlyph)


def render(
    content: Sequence[Content],
    *,
    title: str,
    author: str,
    epoch: int,
    look: Look = PRINT,
    pages: int | None = None,
) -> Pdf:
    """Renders `content` to PDF. `epoch` pins the PDF's dates and id; `pages`, when given, is
    the exact page count the content must come to."""
    if look.hand:
        _hand_glyphs()
    builder = _Builder(look)
    flowables = builder.flowables(content)
    starts_with_images = isinstance(_first(content), Images)
    templates = [_body_template(), _image_template()]
    if starts_with_images:
        templates.reverse()
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        pageTemplates=templates,
        title=title,
        author=author,
        creator=author,
        subject="",
        invariant=1,
        pageCompression=1,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
    )
    canvas_class = _paged_canvas(title if look.footer else None, look)
    with _source_date(epoch):
        try:
            doc.build(flowables or [Spacer(1, 1)], canvasmaker=canvas_class)
        except LayoutError as exc:  # something too big for a page, such as a huge table cell
            raise b.RenderError(str(exc)[:300]) from exc
    count = doc.page
    if pages is not None and count != pages:
        raise b.RenderError(f"expected {pages} pages, rendered {count}")
    return Pdf(buffer.getvalue(), count)


@contextmanager
def _source_date(epoch: int) -> Generator[None]:
    """reportlab takes the PDF's dates, and seeds its document id, from SOURCE_DATE_EPOCH."""
    previous = os.environ.get("SOURCE_DATE_EPOCH")
    os.environ["SOURCE_DATE_EPOCH"] = str(epoch)
    try:
        yield
    finally:
        if previous is None:
            del os.environ["SOURCE_DATE_EPOCH"]
        else:
            os.environ["SOURCE_DATE_EPOCH"] = previous


def _body_template() -> PageTemplate:
    frame = Frame(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN, id="body")

    def on_page(canvas: Any, _doc: Any) -> None:
        canvas.footed.add(canvas.getPageNumber())

    return PageTemplate(id="body", frames=[frame], onPage=on_page)


def _image_template() -> PageTemplate:
    frame = Frame(0, 0, PAGE_W, PAGE_H, 0, 0, 0, 0, id="image")
    return PageTemplate(id="image", frames=[frame])


def _paged_canvas(footer_title: str | None, look: Look) -> type[Canvas]:
    """A canvas that holds pages back until save, so footers can say "Page n of N". This is
    reportlab's own recipe, and it leans on the canvas internals the stubs leave out."""

    class PagedCanvas(Canvas):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)  # pyright: ignore[reportUnknownMemberType]
            self.footed: set[int] = set()
            self._held: list[dict[str, Any]] = []

        def showPage(self) -> None:  # noqa: N802 (reportlab's name)
            self._held.append(dict(self.__dict__))
            self._startPage()  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType]

        def save(self) -> None:
            total = len(self._held)
            for state in self._held:
                self.__dict__.update(state)
                number = self.getPageNumber()
                if footer_title is not None and number in self.footed:
                    self.saveState()
                    self.setFont(look.regular, 8)
                    self.setFillColor(colors.Color(0.35, 0.35, 0.35))
                    self.drawString(MARGIN, FOOTER_Y, footer_title)
                    self.drawRightString(PAGE_W - MARGIN, FOOTER_Y, f"Page {number} of {total}")
                    self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    return PagedCanvas


class _Code(Preformatted):
    """A code block. Its lines never wrap, so one wider than the room it gets would run off the
    page, out of sight but still in the text layer: that fails the build instead."""

    def wrap(self, aW: float, aH: float) -> tuple[float, float]:  # noqa: N803 (reportlab's names)
        for number, line in enumerate(self.lines, 1):
            width = pdfmetrics.stringWidth(line, self.style.fontName, self.style.fontSize)
            if width > aW:
                raise b.RenderError(
                    f"code line {number} is {width / mm:.0f}mm wide, wider than the "
                    f"{aW / mm:.0f}mm the page leaves it: {line[:40]!r}: break or shorten it"
                )
        return super().wrap(aW, aH)


class _Builder:
    def __init__(self, look: Look) -> None:
        self.look = look
        size, leading = look.size, look.leading
        base = ParagraphStyle(
            "body", fontName=look.regular, fontSize=size, leading=leading, spaceAfter=size * 0.6
        )
        self.body = base
        self.heading = {
            level: ParagraphStyle(
                f"h{level}",
                parent=base,
                fontName=look.bold,
                fontSize=size * scale,
                leading=size * scale * 1.25,
                spaceBefore=size * (1.0 if level > 1 else 0.4),
                spaceAfter=size * 0.5,
                keepWithNext=1,
            )
            for level, scale in {1: 1.8, 2: 1.4, 3: 1.2, 4: 1.05, 5: 1.0, 6: 1.0}.items()
        }
        self.cell: dict[tuple[b.Align, bool, float], ParagraphStyle] = {}
        self.code = ParagraphStyle(
            "code", parent=base, fontName=look.mono, fontSize=size * 0.85, leading=size * 1.15
        )
        self.hidden = ParagraphStyle(
            "hidden", parent=base, fontSize=1, leading=1.2, spaceAfter=0, textColor=colors.white
        )

    def flowables(self, content: Sequence[Content]) -> list[Flowable]:
        out: list[Flowable] = []
        fresh = True
        pending_break = False
        template: Literal["body", "image"] = (
            "image" if isinstance(_first(content), Images) else "body"
        )
        for item in content:
            if isinstance(item, b.PageBreak):
                pending_break = True
                continue
            wanted = "image" if isinstance(item, Images) else "body"
            if wanted != template:
                out.append(NextPageTemplate(wanted))
                template = wanted
                if not fresh:
                    out.append(PageBreak())
                fresh, pending_break = True, False
            if pending_break and not fresh:
                out.append(PageBreak())
            pending_break = False
            if isinstance(item, Images):
                out.extend(Image(io.BytesIO(page), PAGE_W, PAGE_H) for page in item.pages)
                fresh = True  # the image fills its page, so whatever follows starts a new one
            else:
                out.extend(self.block(item))
                fresh = False
        return out

    def block(self, block: b.Block) -> list[Flowable]:
        match block:
            case b.Heading(level, content):
                return [Paragraph(self.markup(content), self.heading[level])]
            case b.Paragraph(content):
                return [Paragraph(self.markup(content), self.body)]
            case b.ListBlock():
                return [self.listing(block)]
            case b.Table():
                return [self.table(block), Spacer(1, self.look.size * 0.8)]
            case b.Code(text):
                return [_Code(self.text(text), self.code)]
            case b.Quote(inner):
                return [Indenter(left=14), *self.blocks(inner), Indenter(left=-14)]
            case b.Rule():
                return [HRFlowable(width="100%", thickness=0.5, color=colors.grey, spaceAfter=6)]
            case b.Hidden(inner):
                return [Paragraph(escape(self.text(line)), self.hidden) for line in b.lines(inner)]
            case b.Scan():
                raise b.RenderError("scan regions are only for pdf_mixed")
            case b.PageBreak():
                return [PageBreak()]

    def blocks(self, blocks: Sequence[b.Block]) -> list[Flowable]:
        return [flowable for block in blocks for flowable in self.block(block)]

    def listing(self, block: b.ListBlock) -> ListFlowable:
        # ListFlowable takes ListItems, though the stubs only admit flowables.
        if block.ordered and block.start < 1:
            raise b.RenderError("reportlab can't number a list from 0; start it at 1")
        empty: list[Flowable] = [Paragraph("\xa0", self.body)]  # keeps a blank item's bullet
        items = cast(list[Flowable], [ListItem(self.blocks(item) or empty) for item in block.items])
        common: dict[str, Any] = {
            "leftIndent": self.look.size * 1.6,
            "bulletFontSize": self.look.size,
            "spaceAfter": self.look.size * 0.4,
        }
        if block.ordered:
            return ListFlowable(
                items,
                bulletType="1",
                start=block.start,
                bulletFormat="%s.",
                bulletFontName=self.look.regular,
                **common,
            )
        if self.look.hand:
            return ListFlowable(
                items, bulletType="bullet", start="-", bulletFontName=self.look.regular, **common
            )
        # Helvetica's bullet comes out of text extraction as "(cid:127)"; Symbol's maps back.
        return ListFlowable(
            items, bulletType="bullet", start="\u2022", bulletFontName="Symbol", **common
        )

    def table(self, block: b.Table) -> Table:
        width = PAGE_W - 2 * MARGIN
        columns = max(len(block.header), *(len(row) for row in block.rows), 1)
        padding: list[b.Align] = ["left"] * (columns - len(block.align))
        align: list[b.Align] = [*block.align, *padding]
        rows = [block.header, *block.rows]
        cells = [[row[c] if c < len(row) else () for row in rows] for c in range(columns)]
        size, widths = self.column_widths(cells, width)
        data = [
            [
                self.cell_value(row[c] if c < len(row) else (), align[c], r == 0, widths[c], size)
                for c in range(columns)
            ]
            for r, row in enumerate(rows)
        ]
        style = TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.Color(0.45, 0.45, 0.45)),
                *([] if self.look.hand else [("BACKGROUND", (0, 0), (-1, 0), HEADER_FILL)]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONT", (0, 0), (-1, -1), self.look.regular, size),
                ("FONT", (0, 0), (-1, 0), self.look.bold, size),
                ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
                ("LEFTPADDING", (0, 0), (-1, -1), CELL_PAD),
                ("RIGHTPADDING", (0, 0), (-1, -1), CELL_PAD),
                *[
                    ("ALIGN", (c, 0), (c, -1), align[c].upper())
                    for c in range(columns)
                    if align[c] != "left"
                ],
            ]
        )
        return Table(data, colWidths=widths, repeatRows=1, style=style, hAlign="LEFT")

    def column_widths(
        self, columns: list[list[b.Inline]], width: float
    ) -> tuple[float, list[float]]:
        """The table's font size and column widths, laid out as a browser lays out an auto
        table: each column wants its text on one line, and when they can't all have that, only
        the columns with spaces to wrap at give way. No column is narrower than its longest
        word, so a word (a contract number, say) never breaks; when the longest words don't fit
        side by side, the table's font shrinks until they do."""
        pad = 2 * CELL_PAD + _SLACK
        measured = [[self.measure(cell, r == 0) for r, cell in enumerate(c)] for c in columns]
        natural_pt = [max(line for line, _ in column) for column in measured]
        least_pt = [max(word for _, word in column) for column in measured]
        size = self.look.size * 0.9
        if sum(least_pt) * size + pad * len(columns) > width:
            fits = (width - pad * len(columns)) / sum(least_pt)
            smallest = self.look.size * MIN_TABLE_SCALE
            if fits < smallest:
                words = (sum(least_pt) * smallest + pad * len(columns)) / mm
                raise b.RenderError(
                    f"a table's longest words need {words:.0f}mm side by side even at "
                    f"{smallest:g}pt, wider than the {width / mm:.0f}mm page: split the table"
                )
            size = math.floor(fits * 10) / 10
        natural = [n * size + pad for n in natural_pt]
        if sum(natural) <= width:
            return size, [w * width / sum(natural) for w in natural]
        least = [m * size + pad for m in least_pt]
        give = [n - m for n, m in zip(natural, least, strict=True)]
        spare = (width - sum(least)) / sum(give)
        return size, [m + g * spare for m, g in zip(least, give, strict=True)]

    def measure(self, content: b.Inline, header: bool) -> tuple[float, float]:
        """The widest line and the widest word of a cell, per point of font size."""
        widest_line = widest_word = line = word = 0.0
        for span in content:
            font = self.font(span, header)
            for piece in re.split(r"(\s)", span.text):
                if not piece:
                    continue
                if piece.isspace():
                    widest_word, word = max(widest_word, word), 0.0
                    if piece == "\n":
                        widest_line, line = max(widest_line, line), 0.0
                    else:
                        line += pdfmetrics.stringWidth(" ", font, 1)
                else:
                    piece_width = pdfmetrics.stringWidth(piece, font, 1)
                    line += piece_width
                    word += piece_width
        return max(widest_line, line), max(widest_word, word)

    def font(self, span: b.Span, header: bool) -> str:
        if span.code:
            return self.look.mono
        bold = header or span.bold
        if bold:
            return self.look.bold_italic if span.italic else self.look.bold
        return self.look.italic if span.italic else self.look.regular

    def cell_value(
        self, content: b.Inline, align: b.Align, header: bool, width: float, size: float
    ) -> Any:
        # Plain short cells skip Paragraph layout, which keeps the long filing fast.
        if len(content) <= 1 and all(not (s.bold or s.italic or s.code) for s in content):
            text = self.text("".join(s.text for s in content))
            font = self.look.bold if header else self.look.regular
            if "\n" not in text and (
                pdfmetrics.stringWidth(text, font, size) <= width - 2 * CELL_PAD
            ):
                return text
        return Paragraph(self.markup(content), self.cell_style(align, header, size))

    def cell_style(self, align: b.Align, header: bool, size: float) -> ParagraphStyle:
        key = (align, header, size)
        if key not in self.cell:
            self.cell[key] = ParagraphStyle(
                f"cell-{align}-{header}-{size:g}",
                parent=self.body,
                fontName=self.look.bold if header else self.look.regular,
                fontSize=size,
                leading=size * 1.25,
                spaceAfter=0,
                alignment=_ALIGNMENT[align],
            )
        return self.cell[key]

    def markup(self, content: b.Inline) -> str:
        parts: list[str] = []
        for span in content:
            text = escape(self.text(span.text)).replace("\n", "<br/>")
            if span.code:
                text = f'<font face="{self.look.mono}">{text}</font>'
            if span.italic:
                text = f"<i>{text}</i>"
            if span.bold:
                text = f"<b>{text}</b>"
            parts.append(text)
        return "".join(parts)

    def text(self, text: str) -> str:
        if self.look.hand:
            missing = {c for c in text if c not in _hand_glyphs() and c not in "\n\t"}
        else:
            missing = {c for c in text if not _cp1252(c)}
        if missing:
            listed = ", ".join(f"{c!r} (U+{ord(c):04X})" for c in sorted(missing))
            raise b.RenderError(f"characters the {self.look.regular} font can't set: {listed}")
        return text


def _first(content: Sequence[Content]) -> Content | None:
    """What the first page shows: page breaks before any content don't make pages."""
    return next((item for item in content if not isinstance(item, b.PageBreak)), None)


def _cp1252(char: str) -> bool:
    try:
        char.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True
