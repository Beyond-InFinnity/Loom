// TTML2 (DFXP) → CaptionEvent[] parser for Amazon Prime Video tracks.
//
// Prime serves each subtitle track as ONE whole TTML2 document (profile
// `TTMLv2`, MIME application/octet-stream) on an unauthenticated,
// ACAO:* CDN (cf-timedtext.aux.pv-cdn.net) whose URL is enumerated in
// the GetVodPlaybackResources JSON (see entrypoints/prime-main.content.ts).
// This turns one fetched TTML body into the same CaptionEvent[] shape
// YouTube's parseJson3 and Netflix's parseVtt produce, so everything
// downstream — stream.ts playhead, the overlay, annotate/romanize
// batching, corpus capture — consumes Prime cues identically.
//
// Validated against a real capture (recon 2026-07-07): Evangelion 3.33
// ja track, 1,482 cues, incl. authored furigana, tate-chu-yoko, and
// vertical-writing regions.  Output contract mirrors parseVtt EXACTLY:
//   - times in integer milliseconds
//   - text trimmed; markup stripped; <br/> → newline; empty cues dropped
//   - result sorted ascending by start
//
// TTML shape (real):
//   <tt xml:lang="jp">
//     <head><styling>
//       <style tts:ruby="base" xml:id="s4"/>
//       <style tts:ruby="text" tts:rubyPosition="before" xml:id="s5"/>
//     </styling></head>
//     <body region="横下" xml:space="preserve"><div>
//       <p begin="00:00:37.747" end="00:00:41.375" style="s1">
//         <span style="s2">（<span style="s3"><span style="s4">青</span>
//         <span style="s5">あお</span></span>…）追跡班<br/>両機の…</span>
//       </p>
//     </div></body>
//   </tt>
//
// Ruby handling — CRITICAL: a ruby annotation renders as base+reading
// INTERLEAVED in the raw markup (青 あお 葉 ば).  Left in, that corrupts
// the plain text the romanizer/annotator sees.  So we read the <head>
// styling map, find every style whose tts:ruby is "text" (the READING),
// and drop those spans' contents — leaving clean base text (青葉).  The
// authored readings are a genuine asset (higher quality than MeCab for
// names), but wiring them into the annotate pipeline is a separate,
// larger change; for now they're dropped so the base text is correct.
// The style-role map already parsed here is what makes that future
// extraction cheap.  (memory: loom-platform-seam / the ja pipeline's
// pre-existing-furigana tier is the eventual consumer.)
//
// Hand-rolled (regex, no DOMParser) for the same reason as parseVtt: the
// module must behave identically under vitest (node, no DOM) and in the
// content script.  The parse is shallow-structural, not a full XML tree —
// ruby-text spans are leaf spans (reading only, no nesting), so a
// non-greedy per-style removal is safe.

import type { CaptionEvent } from "../types";

const NAMED: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function safeCp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Decode the small entity set TTML actually emits. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => safeCp(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeCp(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (e) => NAMED[e.toLowerCase()] ?? "");
}

const CLOCK = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

/** TTML clock time "HH:MM:SS.mmm" / "MM:SS.mmm" → integer ms (null if
    unparseable).  Prime uses media-relative clock time = playhead time. */
export function ttmlTimeToMs(stamp: string): number | null {
  const m = CLOCK.exec(String(stamp).trim());
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  const millis = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** xml:id of every <style> whose tts:ruby is "text" — i.e. the READING
    half of a ruby annotation, which must be dropped from plain text.
    Reads the <head> styling block; robust to Prime's exact ids (s5/s7
    today) changing across titles. */
export function rubyTextStyleIds(doc: string): Set<string> {
  const ids = new Set<string>();
  const head = doc.slice(0, doc.indexOf("</head>") + 1 || undefined);
  // Each <style .../> is self-closing; capture the whole tag and test it.
  for (const tag of head.match(/<style\b[^>]*\/?>/g) ?? []) {
    if (/tts:ruby\s*=\s*"text"/.test(tag)) {
      const id = /xml:id\s*=\s*"([^"]*)"/.exec(tag);
      if (id) ids.add(id[1]);
    }
  }
  return ids;
}

/** The document's declared language, from <tt xml:lang="…">.  Prime uses
    "jp" (not the BCP-47 "ja") on Japanese — callers normalize.  null when
    absent. */
export function ttmlLang(doc: string): string | null {
  const m = /<tt\b[^>]*\bxml:lang\s*=\s*"([^"]*)"/.exec(doc);
  return m ? m[1] : null;
}

/** Turn one <p>…</p> inner markup into clean plain text: drop ruby
    readings, convert <br/> to newline, strip remaining tags, decode
    entities, collapse ASCII whitespace runs (ideographic U+3000 spacing
    is preserved — it's meaningful in JP subtitle layout). */
function cueTextFrom(inner: string, rubyTextIds: Set<string>): string {
  let s = inner;
  // Drop reading spans (leaf spans: reading text only, no nesting) so the
  // base text survives.  Per style id so we never over-match a base span.
  for (const id of rubyTextIds) {
    const re = new RegExp(`<span\\b[^>]*\\bstyle="${id}"[^>]*>[^<]*</span>`, "g");
    s = s.replace(re, "");
  }
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  // Collapse runs of ASCII space/tab only; keep newlines and U+3000.
  s = s.replace(/[ \t]+/g, " ");
  // Trim each line, drop empties, rejoin.
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

/** Parse a full TTML2 document body → CaptionEvent[]. */
export function parseTtml(body: string): CaptionEvent[] {
  const doc = String(body);
  const rubyTextIds = rubyTextStyleIds(doc);
  const result: CaptionEvent[] = [];

  // Match each timed <p …begin=…>…</p>.  [^]*? = any char incl. newlines,
  // non-greedy so nested content stops at the FIRST </p>.  <p> cues don't
  // nest in TTML, so this is safe.
  const pRe = /<p\b([^>]*)>([^]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(doc)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const beginM = /\bbegin\s*=\s*"([^"]*)"/.exec(attrs);
    const endM = /\bend\s*=\s*"([^"]*)"/.exec(attrs);
    if (!beginM || !endM) continue;
    const start = ttmlTimeToMs(beginM[1]);
    const end = ttmlTimeToMs(endM[1]);
    if (start === null || end === null) continue;

    const text = cueTextFrom(inner, rubyTextIds);
    if (text.length === 0) continue;

    result.push({ start, end, text });
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}
