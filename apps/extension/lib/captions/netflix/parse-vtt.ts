// WebVTT → CaptionEvent[] parser for Netflix tracks.
//
// Netflix serves subtitles as WebVTT (profile `webvtt-lssdh-ios8`) on
// signed, time-limited URLs enumerated in the MSL-decrypted manifest
// (see entrypoints/netflix-main.content.ts).  This parser turns one
// fetched WebVTT document body into the same CaptionEvent[] shape that
// YouTube's fanout.ts::parseJson3 produces, so everything downstream —
// stream.ts playhead lookup, the overlay, annotate/romanize batching —
// consumes Netflix cues identically to YouTube events.
//
// Ported from spike/netflix/parse-vtt.mjs, validated against 4 real
// captures (recon 2026-06-18): ja 371, ko 1118, th 19, hi 2836 cues —
// 0 empty cues, 0 reversed timings, all sorted.  Output contract mirrors
// parseJson3 EXACTLY:
//   - times in integer milliseconds
//   - text trimmed; inline tags + the small entity set Netflix emits
//     stripped; empty cues dropped
//   - result sorted ascending by start
//
// Real-capture quirks this handles: WEBVTT/NOTE/Profile/SegmentIndex
// header blocks, whitespace-only padding blocks, comma-bearing cue
// settings (`position:50.00%,middle align:middle`), and
// <c.japanese>/nested <c.bg_transparent> class wrappers.  Inline
// furigana-in-parens (（金田(かなだ)）) is deliberately PRESERVED as text —
// a free gift to the annotation layer where Netflix ships it.
//
// We hand-roll a regex parser rather than lean on the browser-native
// VTTCue path so this module is identical under vitest (no DOM) and in
// the extension, and so the cue-text cleanup stays under our control.

import type { CaptionEvent } from "../types";

const NAMED: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&lrm;": "", // LEFT-TO-RIGHT MARK — bidi control, drop
  "&rlm;": "", // RIGHT-TO-LEFT MARK — bidi control, drop
};

function safeCp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Decode the small set of HTML entities Netflix VTT actually emits. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => safeCp(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeCp(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (e) => NAMED[e.toLowerCase()] ?? "");
}

/** Strip inline tags (<i>, <c.bg_transparent>, <00:00:00.000>…) + entities. */
export function cleanText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+/g, " ")
    .trim();
}

const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** "HH:MM:SS.mmm" or "MM:SS.mmm" → integer milliseconds (null if unparseable). */
export function vttTimeToMs(stamp: string): number | null {
  const m = TIMESTAMP.exec(String(stamp).trim());
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  const millis = parseInt(m[4].padEnd(3, "0"), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** Parse a full WebVTT document body → CaptionEvent[]. */
export function parseVtt(body: string): CaptionEvent[] {
  const result: CaptionEvent[] = [];
  const blocks = String(body)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n");
    // The cue's timing line is the one containing "-->".  Anything before
    // it in the block is an optional cue identifier; STYLE/REGION/NOTE/the
    // WEBVTT header blocks have no "-->" and are skipped.
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue;

    const [startRaw, rest] = lines[timingIdx].split("-->");
    if (rest === undefined) continue;
    const endRaw = rest.trim().split(/\s+/)[0]; // drop cue settings after end ts
    const start = vttTimeToMs(startRaw);
    const end = vttTimeToMs(endRaw);
    if (start === null || end === null) continue;

    const text = lines
      .slice(timingIdx + 1)
      .map(cleanText)
      .filter((l) => l.length > 0)
      .join("\n")
      .trim();
    if (text.length === 0) continue;

    result.push({ start, end, text });
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}
