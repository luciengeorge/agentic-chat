# python-docx's oxml layer (lxml underneath) has no type information, and only its private
# _p and _tr reach it.
# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""Blocks to DOCX with python-docx: real headings, lists and tables; hidden runs white and 1pt."""

import io
import zipfile
from datetime import datetime

import docx
from docx.document import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls
from docx.shared import Pt, RGBColor
from docx.text.paragraph import Paragraph

from ac_fixtures.corpus import blocks as b

MONO = "Courier New"
_ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
}
_RULE = (
    f"<w:pBdr {nsdecls('w')}>"
    '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr>'
)


def render(
    content: tuple[b.Block, ...], *, title: str, author: str, created: datetime, modified: datetime
) -> bytes:
    document = docx.Document()
    props = document.core_properties
    props.title = title
    props.author = author
    props.last_modified_by = author
    props.created = created
    props.modified = modified
    props.revision = 1
    props.comments = ""
    writer = _Writer(document)
    for block in content:
        writer.block(block)
    out = io.BytesIO()
    document.save(out)
    return _pinned(out.getvalue(), modified)


def _pinned(package: bytes, when: datetime) -> bytes:
    """The same zip with every entry stamped `when`: zipfile otherwise stamps the wall clock."""
    out = io.BytesIO()
    stamp = (when.year, when.month, when.day, when.hour, when.minute, when.second)
    with (
        zipfile.ZipFile(io.BytesIO(package)) as source,
        zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        for entry in source.infolist():
            info = zipfile.ZipInfo(entry.filename, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # Unix, whatever platform builds it
            info.external_attr = 0o644 << 16
            target.writestr(info, source.read(entry.filename))
    return out.getvalue()


class _Writer:
    def __init__(self, document: Document) -> None:
        self.document = document

    def block(self, block: b.Block, depth: int = 0) -> None:
        match block:
            case b.Heading(level, content):
                self.runs(self.document.add_heading("", level), content)
            case b.Paragraph(content):
                self.runs(self.document.add_paragraph(), content)
            case b.ListBlock():
                self.listing(block, depth)
            case b.Table():
                self.table(block)
            case b.Code(text):
                self.runs(self.document.add_paragraph(), (b.Span(text, code=True),))
            case b.Quote(inner):
                for quoted in inner:
                    if isinstance(quoted, b.Paragraph):
                        self.runs(self.document.add_paragraph(style="Quote"), quoted.content)
                    else:
                        self.block(quoted, depth)
            case b.Rule():
                self.document.add_paragraph()._p.get_or_add_pPr().append(parse_xml(_RULE))
            case b.PageBreak():
                self.document.add_page_break()
            case b.Hidden(inner):
                for line in b.lines(inner):
                    run = self.document.add_paragraph().add_run(line)
                    run.font.size = Pt(1)
                    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            case b.Scan():
                raise b.RenderError("scan regions are only for pdf_mixed")

    def runs(self, paragraph: Paragraph, content: b.Inline) -> None:
        for span in content:
            for i, piece in enumerate(span.text.split("\n")):
                if i:
                    paragraph.add_run().add_break()
                if not piece:
                    continue
                run = paragraph.add_run(piece)
                run.bold = span.bold or None
                run.italic = span.italic or None
                if span.code:
                    run.font.name = MONO

    def listing(self, block: b.ListBlock, depth: int) -> None:
        level = min(depth, 2)
        kind = "List Number" if block.ordered else "List Bullet"
        style = kind if level == 0 else f"{kind} {level + 1}"
        num_id = self.restarted(style, block.start) if block.ordered else None
        for item in block.items:
            rest = list(item)
            if rest and isinstance(rest[0], b.Paragraph):
                paragraph = self.document.add_paragraph(style=style)
                self.runs(paragraph, rest.pop(0).content)
                if num_id is not None:
                    num_pr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
                    num_pr.get_or_add_ilvl().val = 0
                    num_pr.get_or_add_numId().val = num_id
            for nested in rest:
                self.block(nested, depth + 1)

    def restarted(self, style: str, start: int) -> int:
        """A fresh numbering instance of `style`'s list, so each ordered list counts from its
        own start instead of carrying on from the previous one."""
        numbering = self.document.part.numbering_part.element
        style_num_id = self.document.styles[style].element.pPr.numPr.numId.val
        abstract_id = numbering.num_having_numId(style_num_id).abstractNumId.val
        num = numbering.add_num(abstract_id)
        num.add_lvlOverride(ilvl=0).add_startOverride(start)
        return num.numId

    def table(self, block: b.Table) -> None:
        columns = max(len(block.header), *(len(row) for row in block.rows), 1)
        padding: list[b.Align] = ["left"] * (columns - len(block.align))
        align = [*block.align, *padding]
        rows = [block.header, *block.rows]
        table = self.document.add_table(rows=len(rows), cols=columns)
        table.style = "Table Grid"
        table.rows[0]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
        for r, row in enumerate(rows):
            for c in range(columns):
                paragraph = table.cell(r, c).paragraphs[0]
                paragraph.alignment = _ALIGN[align[c]]
                content = row[c] if c < len(row) else ()
                if r == 0:
                    content = tuple(b.Span(s.text, True, s.italic, s.code) for s in content)
                self.runs(paragraph, content)
        self.document.add_paragraph()
