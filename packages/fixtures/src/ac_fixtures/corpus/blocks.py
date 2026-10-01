"""Document bodies as a small block tree: CommonMark, GFM pipe tables and the corpus directives."""

import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Literal

from markdown_it import MarkdownIt
from markdown_it.tree import SyntaxTreeNode


class RenderError(Exception):
    pass


@dataclass(frozen=True)
class Span:
    text: str
    bold: bool = False
    italic: bool = False
    code: bool = False


Inline = tuple[Span, ...]
Align = Literal["left", "center", "right"]
Directive = Literal["pagebreak", "scan", "hidden"]


@dataclass(frozen=True)
class Heading:
    level: int
    content: Inline


@dataclass(frozen=True)
class Paragraph:
    content: Inline


@dataclass(frozen=True)
class ListBlock:
    ordered: bool
    start: int
    items: tuple[tuple["Block", ...], ...]


@dataclass(frozen=True)
class Table:
    header: tuple[Inline, ...]
    rows: tuple[tuple[Inline, ...], ...]
    align: tuple[Align, ...]


@dataclass(frozen=True)
class Code:
    text: str


@dataclass(frozen=True)
class Quote:
    blocks: tuple["Block", ...]


@dataclass(frozen=True)
class Rule:
    pass


@dataclass(frozen=True)
class PageBreak:
    pass


@dataclass(frozen=True)
class Hidden:
    """Invisible to a reader (white, 1pt) but present in the text layer."""

    blocks: tuple["Block", ...]


@dataclass(frozen=True)
class Scan:
    """Rendered as scanned image pages with no text layer (pdf_mixed)."""

    blocks: tuple["Block", ...]


Block = Heading | Paragraph | ListBlock | Table | Code | Quote | Rule | PageBreak | Hidden | Scan

_DIRECTIVE = re.compile(r"<!--\s*(pagebreak|scan-begin|scan-end|hidden-begin|hidden-end)\s*-->")
_ALIGN = re.compile(r"text-align:\s*(left|center|right)")
_MD = MarkdownIt("commonmark").enable("table")


def parse(body: str) -> tuple[Block, ...]:
    root = SyntaxTreeNode(_MD.parse(body))
    stack: list[tuple[str, list[Block]]] = [("", [])]
    for node in root.children:
        if node.type != "html_block":
            stack[-1][1].append(_block(node))
            continue
        match _directive(node):
            case "pagebreak":
                stack[-1][1].append(PageBreak())
            case "scan-begin" | "hidden-begin" as begin:
                if len(stack) > 1:
                    raise RenderError(f"<!-- {begin} --> inside <!-- {stack[-1][0]}-begin -->")
                stack.append((begin.removesuffix("-begin"), []))
            case end:
                kind = end.removesuffix("-end")
                if stack[-1][0] != kind:
                    raise RenderError(f"<!-- {end} --> without <!-- {kind}-begin -->")
                _, blocks = stack.pop()
                region = Scan(tuple(blocks)) if kind == "scan" else Hidden(tuple(blocks))
                stack[-1][1].append(region)
    if len(stack) > 1:
        raise RenderError(f"<!-- {stack[-1][0]}-begin --> is never closed")
    return tuple(stack[0][1])


def directives(blocks: tuple[Block, ...]) -> set[Directive]:
    found: set[Directive] = set()
    for block in blocks:
        match block:
            case PageBreak():
                found.add("pagebreak")
            case Scan(inner):
                found |= {"scan", *directives(inner)}
            case Hidden(inner):
                found |= {"hidden", *directives(inner)}
            case _:
                pass
    return found


def plain(content: Inline) -> str:
    return "".join(span.text for span in content)


def lines(blocks: Sequence[Block]) -> Iterator[str]:
    """The text of `blocks`, a line per paragraph, list item or table row."""
    for block in blocks:
        match block:
            case Heading(_, content) | Paragraph(content):
                yield plain(content)
            case ListBlock(items=items):
                for item in items:
                    yield from lines(item)
            case Table(header, rows):
                for row in (header, *rows):
                    yield " | ".join(plain(cell) for cell in row)
            case Code(text):
                yield text
            case Quote(inner) | Hidden(inner) | Scan(inner):
                yield from lines(inner)
            case Rule() | PageBreak():
                pass


def _directive(node: SyntaxTreeNode) -> str:
    match = _DIRECTIVE.fullmatch(node.content.strip())
    if match is None:
        raise RenderError(f"raw HTML is not allowed: {node.content.strip()[:60]!r}")
    return match.group(1)


def _block(node: SyntaxTreeNode) -> Block:
    match node.type:
        case "heading":
            return Heading(int(node.tag[1]), _inline(node.children[0]))
        case "paragraph":
            return Paragraph(_inline(node.children[0]))
        case "bullet_list" | "ordered_list":
            start = node.attrs.get("start", 1)
            items = tuple(tuple(_block(child) for child in item.children) for item in node.children)
            return ListBlock(node.type == "ordered_list", int(start), items)
        case "table":
            return _table(node)
        case "fence" | "code_block":
            return Code(node.content.rstrip("\n"))
        case "blockquote":
            return Quote(tuple(_block(child) for child in node.children))
        case "hr":
            return Rule()
        case "html_block":
            raise RenderError(f"<!-- {_directive(node)} --> must be at the top level")
        case other:
            raise RenderError(f"unsupported markdown: {other}")


def _table(node: SyntaxTreeNode) -> Table:
    rows: list[tuple[Inline, ...]] = []
    align: list[Align] = []
    for section in node.children:
        for row in section.children:
            cells = row.children
            rows.append(tuple(_inline(cell.children[0]) if cell.children else () for cell in cells))
            if not align:
                align = [_cell_align(cell) for cell in row.children]
    return Table(header=rows[0], rows=tuple(rows[1:]), align=tuple(align))


def _cell_align(cell: SyntaxTreeNode) -> Align:
    match = _ALIGN.search(str(cell.attrs.get("style", "")))
    if match is None:
        return "left"
    value = match.group(1)
    return "right" if value == "right" else "center" if value == "center" else "left"


def _inline(node: SyntaxTreeNode) -> Inline:
    spans: list[Span] = []

    def walk(n: SyntaxTreeNode, bold: bool, italic: bool) -> None:
        for child in n.children:
            match child.type:
                case "text":
                    spans.append(Span(child.content, bold, italic))
                case "softbreak":
                    spans.append(Span(" ", bold, italic))
                case "hardbreak":
                    spans.append(Span("\n", bold, italic))
                case "code_inline":
                    spans.append(Span(child.content, bold, italic, code=True))
                case "strong":
                    walk(child, True, italic)
                case "em":
                    walk(child, bold, True)
                case "link":
                    walk(child, bold, italic)
                case "html_inline":
                    raise RenderError(f"raw HTML is not allowed: {child.content!r}")
                case other:
                    raise RenderError(f"unsupported inline markdown: {other}")

    walk(node, False, False)
    return _merge(spans)


def _merge(spans: list[Span]) -> Inline:
    merged: list[Span] = []
    for span in spans:
        last = merged[-1] if merged else None
        if last is not None and (last.bold, last.italic, last.code) == (
            span.bold,
            span.italic,
            span.code,
        ):
            merged[-1] = Span(last.text + span.text, span.bold, span.italic, span.code)
        else:
            merged.append(span)
    return tuple(merged)
