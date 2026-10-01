"""Blocks to PDF with reportlab: a text layer, real (ruled) tables, and a fixed page order."""

import io
import os
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
        cell = ParagraphStyle(
            "cell", parent=base, fontSize=size * 0.9, leading=size * 0.9 * 1.25, spaceAfter=0
        )
        self.cell = {
            (align, bold): ParagraphStyle(
                f"cell-{align}-{bold}",
                parent=cell,
                alignment=_ALIGNMENT[align],
                fontName=look.bold if bold else look.regular,
            )
            for align in _ALIGNMENT
            for bold in (False, True)
        }
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
                return [Preformatted(self.text(text), self.code)]
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
        widths = self.column_widths(cells, width)
        data = [
            [
                self.cell_value(row[c] if c < len(row) else (), align[c], r == 0, widths[c])
                for c in range(columns)
            ]
            for r, row in enumerate(rows)
        ]
        style = TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.Color(0.45, 0.45, 0.45)),
                *([] if self.look.hand else [("BACKGROUND", (0, 0), (-1, 0), HEADER_FILL)]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONT", (0, 0), (-1, -1), self.look.regular, self.look.size * 0.9),
                ("FONT", (0, 0), (-1, 0), self.look.bold, self.look.size * 0.9),
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

    def column_widths(self, columns: list[list[b.Inline]], width: float) -> list[float]:
        """Widths as a browser lays out an auto table: each column wants its text on one line,
        and when they can't all have that, only the columns with spaces to wrap at give way."""
        size = self.look.size * 0.9
        pad = 2 * CELL_PAD

        def measure(text: str, header: bool) -> float:
            return pdfmetrics.stringWidth(
                text, self.look.bold if header else self.look.regular, size
            )

        natural = [
            max(measure(b.plain(cell), r == 0) for r, cell in enumerate(column)) + pad
            for column in columns
        ]
        if sum(natural) <= width:
            return [w * width / sum(natural) for w in natural]
        least = [
            max(
                (
                    measure(word, r == 0)
                    for r, cell in enumerate(column)
                    for word in b.plain(cell).split()
                ),
                default=0.0,
            )
            + pad
            for column in columns
        ]
        if sum(least) >= width:
            return [w * width / sum(least) for w in least]
        give = [n - m for n, m in zip(natural, least, strict=True)]
        spare = (width - sum(least)) / sum(give)
        return [m + g * spare for m, g in zip(least, give, strict=True)]

    def cell_value(self, content: b.Inline, align: b.Align, header: bool, width: float) -> Any:
        # Plain short cells skip Paragraph layout, which keeps the long filing fast.
        if len(content) <= 1 and all(not (s.bold or s.italic or s.code) for s in content):
            text = self.text("".join(s.text for s in content))
            font = self.look.bold if header else self.look.regular
            if "\n" not in text and (
                pdfmetrics.stringWidth(text, font, self.look.size * 0.9) <= width - 2 * CELL_PAD
            ):
                return text
        return Paragraph(self.markup(content), self.cell[(align, header)])

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
