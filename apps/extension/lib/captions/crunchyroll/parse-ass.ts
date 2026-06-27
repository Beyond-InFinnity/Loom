// SubStation Alpha (ASS) → CaptionEvent[] parser for Crunchyroll tracks.
//
// Crunchyroll serves its *soft* subtitle tracks as standalone files whose
// URLs are enumerated in the player's `/playback/v*/.../play` JSON response
// (see entrypoints/crunchyroll-main.content.ts).  Each track declares a
// `format` of "ass" (the primary/original-language tracks) or "vtt" (newer
// English closed-captions).  VTT tracks reuse netflix/parse-vtt.ts; this
// module handles ASS, turning one fetched .ass document body into the same
// CaptionEvent[] shape parseJson3 (YouTube) and parseVtt (Netflix) produce,
// so everything downstream — stream.ts playhead lookup, the overlay,
// annotate/romanize batching — consumes Crunchyroll cues identically.
//
// Output contract mirrors the other parsers EXACTLY:
//   - times in integer milliseconds
//   - override tags stripped, line breaks normalised, empty cues dropped
//   - result sorted ascending by start
//
// ASS specifics this handles:
//   - the `[Events]` section's `Format:` header (column order is
//     file-declared, not fixed — we resolve Start/End/Text by name, with a
//     fallback to the canonical order)
//   - only `Dialogue:` lines (Comment:/Picture:/etc. are skipped)
//   - centisecond timestamps `H:MM:SS.cc`
//   - inline override blocks `{\i1}`, `{\an8}`, `{\pos(…)}`, `{\c&H…&}` …
//   - hard/soft line breaks `\N` / `\n`, hard space `\h`
//   - vector-drawing runs (`{\p1}…{\p0}`): the commands between them are
//     geometry, not text, so that run is dropped
//
// We hand-roll the parser (no DOM) so it is identical under vitest and in
// the extension.

import type { CaptionEvent } from "../types";

/** "H:MM:SS.cc" (centiseconds) → integer milliseconds (null if unparseable). */
export function assTimeToMs(stamp: string): number | null {
  const m = /(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(String(stamp).trim());
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  // ASS fractional part is CENTISeconds (2 digits).  Pad to 2, scale to ms.
  const centis = parseInt(m[4].slice(0, 2).padEnd(2, "0"), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + centis * 10;
}

/** Strip ASS override blocks + drawing runs, normalise breaks → plain text. */
export function cleanAssText(raw: string): string {
  let out = "";
  let drawing = false; // inside a {\p<n>} vector-drawing run (n > 0)

  // Walk the field, consuming {...} override blocks and the literal text
  // between them.  Drawing runs contribute no text.
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "{") {
      const close = raw.indexOf("}", i + 1);
      if (close === -1) break; // unterminated block — drop the rest
      const block = raw.slice(i + 1, close);
      // \p0 ends drawing mode; \p<nonzero> begins it.  Last \p in the block wins.
      const p = /\\p(\d+)/g;
      let pm: RegExpExecArray | null;
      let last: number | null = null;
      while ((pm = p.exec(block)) !== null) last = parseInt(pm[1], 10);
      if (last !== null) drawing = last > 0;
      i = close + 1;
      continue;
    }
    if (!drawing) out += ch;
    i++;
  }

  return out
    .replace(/\\N/g, "\n") // hard line break
    .replace(/\\n/g, "\n") // soft line break (treat as break)
    .replace(/\\h/g, " ") // hard space
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

/** Resolve column indices from an `[Events]` `Format:` header line.
    Returns the canonical ASS order when the header is missing/garbled. */
function resolveColumns(formatLine: string | null): {
  start: number;
  end: number;
  text: number;
} {
  // Canonical: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  const fallback = { start: 1, end: 2, text: 9 };
  if (!formatLine) return fallback;
  const cols = formatLine
    .slice(formatLine.indexOf(":") + 1)
    .split(",")
    .map((c) => c.trim().toLowerCase());
  const start = cols.indexOf("start");
  const end = cols.indexOf("end");
  const text = cols.indexOf("text");
  if (start === -1 || end === -1 || text === -1) return fallback;
  return { start, end, text };
}

/** Parse a full ASS document body → CaptionEvent[]. */
export function parseAss(body: string): CaptionEvent[] {
  const result: CaptionEvent[] = [];
  const lines = String(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let inEvents = false;
  let cols = resolveColumns(null);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith("[")) {
      inEvents = line.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(line)) {
      cols = resolveColumns(line);
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue; // skip Comment:/Picture:/etc.

    // Split off only the leading fields; Text is the last column and may
    // itself contain commas, so everything from cols.text onward is text.
    const fields = line.slice(line.indexOf(":") + 1).split(",");
    if (fields.length <= cols.text) continue;

    const start = assTimeToMs(fields[cols.start] ?? "");
    const end = assTimeToMs(fields[cols.end] ?? "");
    if (start === null || end === null) continue;

    const text = cleanAssText(fields.slice(cols.text).join(",").trim());
    if (text.length === 0) continue;

    result.push({ start, end, text });
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}
