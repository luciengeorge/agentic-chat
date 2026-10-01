"""One document source to the bytes fake-workspace serves, by format."""

from dataclasses import dataclass
from datetime import datetime
from functools import partial

from ac_fixtures.corpus import blocks as b
from ac_fixtures.corpus import filing, pdf, raster, word
from ac_fixtures.sources import Format

MIME_TYPES: dict[Format, str] = {
    "pdf": "application/pdf",
    "pdf_mixed": "application/pdf",
    "scan": "application/pdf",
    "handwriting": "application/pdf",
    "generated": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown",
}
GENERATORS = {"regulatory_filing": filing.build}


@dataclass(frozen=True)
class Document:
    key: str  # "<tenant>/<id>"; seeds the paper artefacts
    format: Format
    title: str
    author: str  # display name
    created: datetime
    modified: datetime
    body: str
    generator: str | None = None
    pages: int | None = None
    seed: int | None = None


@dataclass(frozen=True)
class Rendered:
    data: bytes
    mime_type: str
    pages: int | None  # PDFs only


def render(doc: Document) -> Rendered:
    mime = MIME_TYPES[doc.format]
    if doc.format == "md":
        # The body starts after the frontmatter's closing ---, usually with a blank line.
        return Rendered(doc.body.lstrip("\n").encode(), mime, None)
    if doc.format == "docx":
        data = word.render(
            b.parse(doc.body),
            title=doc.title,
            author=doc.author,
            created=doc.created,
            modified=doc.modified,
        )
        return Rendered(data, mime, None)
    out = _pdf(doc)
    return Rendered(out.data, mime, out.pages)


def _pdf(doc: Document) -> pdf.Pdf:
    paged = partial(pdf.render, title=doc.title, author=doc.author, epoch=_epoch(doc.modified))

    def copies(
        content: tuple[b.Block, ...], look: pdf.Look, wear: raster.Wear, seed: str
    ) -> pdf.Images:
        return pdf.Images(raster.copies(paged(content, look=look).data, wear, seed))

    match doc.format:
        case "pdf":
            return paged(b.parse(doc.body))
        case "scan":
            return paged([copies(b.parse(doc.body), pdf.PRINT_PLAIN, raster.SCANNER, doc.key)])
        case "handwriting":
            return paged([copies(b.parse(doc.body), pdf.HAND, raster.PAPER, doc.key)])
        case "pdf_mixed":
            content: list[pdf.Content] = [
                copies(block.blocks, pdf.PRINT_PLAIN, raster.SCANNER, f"{doc.key}:{i}")
                if isinstance(block, b.Scan)
                else block
                for i, block in enumerate(b.parse(doc.body))
            ]
            return paged(content)
        case "generated":
            generate = GENERATORS.get(doc.generator or "")
            if generate is None or doc.pages is None or doc.seed is None:
                raise b.RenderError(f"no generator {doc.generator!r}, or no pages or seed")
            return paged(generate(doc.body, pages=doc.pages, seed=doc.seed), pages=doc.pages)
        case "docx" | "md":
            raise AssertionError(doc.format)


def _epoch(when: datetime) -> int:
    if when.tzinfo is None:
        raise ValueError("document times must carry a time zone")
    return int(when.timestamp())
