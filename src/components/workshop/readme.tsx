import type { ReactNode } from "react";

import { parseBlocks } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";

import { HINT_LEGEND, hintEmoji } from "./hints";

const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<>]+[^\s)<>.,;:])/g;

/** Where a link goes: this app's own pages by path, other sites in a new tab, anything else (a repo file) nowhere. */
function href(url: string): { to: string; external: boolean } | null {
  if (url.startsWith("/")) return { to: url, external: false };
  if (!/^https?:\/\//.test(url)) return null;
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  return local
    ? { to: `${parsed.pathname}${parsed.search}${parsed.hash}`, external: false }
    : { to: url, external: true };
}

function link(text: ReactNode, url: string, key: string): ReactNode {
  const target = href(url);
  if (!target) return <span key={key}>{text}</span>;
  return (
    <a
      key={key}
      href={target.to}
      {...(target.external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="font-medium text-primary underline decoration-primary/30 underline-offset-3 hover:decoration-primary"
    >
      {text}
    </a>
  );
}

export function inline(text: string, prefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const key = `${prefix}-${match.index}`;
    if (match.index > last) out.push(text.slice(last, match.index));
    const [, code, bold, em, linkText, linkUrl, bare] = match;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (bold !== undefined) out.push(<strong key={key}>{inline(bold, key)}</strong>);
    else if (em !== undefined) out.push(<em key={key}>{inline(em, key)}</em>);
    else if (linkText !== undefined) out.push(link(inline(linkText, key), linkUrl!, key));
    else if (bare !== undefined) out.push(link(bare, bare, key));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const MEANING = new Map<string, string>(HINT_LEGEND.map((hint) => [hint.emoji, hint.meaning]));

/** A paragraph that opens with a hint's emoji, with the emoji hanging in a gutter, as the code's hints read. */
function Hinted({ text, children }: { text: string; children: (rest: string) => ReactNode }) {
  const emoji = hintEmoji(text);
  if (!emoji) return <p>{children(text)}</p>;
  // A wrapper would fight the prose margins (unlayered CSS beats utilities), so the paragraph itself makes room.
  return (
    <p className="relative pl-8">
      <span
        className="absolute top-0 left-0 select-none"
        title={MEANING.get(emoji)}
        aria-label={MEANING.get(emoji)}
        role="img"
      >
        {emoji}
      </span>
      {children(text.slice(emoji.length).trimStart())}
    </p>
  );
}

/** A course README: the repo's own markdown, so links are kept (unlike a model's answer). */
export function Readme({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose max-w-none text-[0.9375rem] leading-7 text-foreground prose-zinc dark:prose-invert",
        "prose-headings:scroll-mt-20 prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-3xl prose-h2:mt-10 prose-h2:text-xl",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:rounded-lg prose-pre:border prose-pre:bg-muted prose-pre:text-foreground prose-pre:[&_code]:bg-transparent prose-pre:[&_code]:p-0",
        className,
      )}
    >
      {parseBlocks(text).map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case "heading": {
            const Tag = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[block.level - 1]!;
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case "paragraph":
            return (
              <Hinted key={key} text={block.text}>
                {(rest) => inline(rest, key)}
              </Hinted>
            );
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case "list": {
            const items = block.items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>);
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "table":
            return (
              <div key={key} className="not-prose my-6 overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      {block.header.map((cell, c) => (
                        <th key={c} className="px-3 py-2 text-left font-medium">
                          {inline(cell, `${key}-h${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-t">
                        {row.map((cell, c) => (
                          <td key={c} className="px-3 py-2 align-top [&_code]:rounded [&_code]:bg-muted [&_code]:px-1">
                            {inline(cell, `${key}-${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
