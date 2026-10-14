/** How a chunk's text starts: a table header repeated from the chunk before, then units repeated as overlap. */
export interface Repeats {
  /** Characters at the start that are a table header the chunk before also holds. */
  header: number;
  /** Characters after the header that end the chunk before too: the overlap. */
  overlap: number;
}

const TABLE_HEADER = /^(\|[^\n]*\n\| ---[^\n]*)\n/;

/**
 * Marks what `text` repeats from `prev`, for the chunking lab: the longest start of `text` (after a repeated
 * table header) that `prev` ends with, cut where a word ends. It reads the finished texts only, so it shows
 * whatever chunker made them.
 */
export function repeats(prev: string | null, text: string): Repeats {
  if (!prev) return { header: 0, overlap: 0 };
  const header = TABLE_HEADER.exec(text);
  const skip = header && prev.includes(header[1]) ? header[0].length : 0;
  const rest = text.slice(skip);
  for (let end = Math.min(rest.length, prev.length); end > 0; end--) {
    const boundary = end === rest.length || /\s/.test(rest[end]);
    if (boundary && prev.endsWith(rest.slice(0, end))) return { header: skip, overlap: end };
  }
  return { header: skip, overlap: 0 };
}
