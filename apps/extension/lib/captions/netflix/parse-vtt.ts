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

import type { CaptionEvent, CueLayout, WritingMode } from "../types";

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

/** Parse a WebVTT cue-settings string — everything after the end timestamp,
    e.g. "line:10.00% position:50.00%,middle align:middle" (or a
    "vertical:rl" that Netflix never actually emits) — into a CueLayout.

    Returns undefined for the DEFAULT bottom-center horizontal placement (the
    vast majority of cues), so standard cues stay layout-free and render
    through the normal main slot; only genuinely positioned / vertical cues
    carry layout the overlay reproduces.  Real Netflix captures (2026-06-18,
    ja/ko/th/hi) show no `vertical:` ever and `line:` ∈ {10% (top signs),
    ~79-85% (bottom)} — so in practice this lifts top-positioned cues to the
    top and leaves everything else exactly as before. */
export function parseCueSettings(settings: string): CueLayout | undefined {
  if (!settings.trim()) return undefined;

  let vertical: string | undefined;
  let line: string | undefined;
  let position: string | undefined;
  let align: string | undefined;
  let region: string | undefined;
  for (const tok of settings.trim().split(/\s+/)) {
    const ci = tok.indexOf(":");
    if (ci === -1) continue;
    const key = tok.slice(0, ci).toLowerCase();
    const val = tok.slice(ci + 1);
    if (key === "vertical") vertical = val.toLowerCase();
    else if (key === "line") line = val;
    else if (key === "position") position = val;
    else if (key === "align") align = val.toLowerCase();
    else if (key === "region") region = val;
  }

  const writingMode: WritingMode =
    vertical === "rl"
      ? "vertical-rl"
      : vertical === "lr"
        ? "vertical-lr"
        : "horizontal";
  const isVertical = writingMode !== "horizontal";
  const linePct = pctOf(line);
  const posPct = pctOf(position);

  let block: CueLayout["block"];
  let inline: CueLayout["inline"];
  if (!isVertical) {
    // Horizontal: `line` is the block (vertical) axis, `position` the inline.
    block =
      linePct === undefined
        ? "bottom"
        : linePct < 33
          ? "top"
          : linePct < 66
            ? "middle"
            : "bottom";
    inline =
      posPct === undefined
        ? "center"
        : posPct < 33
          ? "left"
          : posPct < 66
            ? "center"
            : "right";
  } else {
    // Vertical: `line` places the column on the inline (horizontal) axis —
    // for vertical-rl it grows right→left (0%=right); `position` runs the
    // block (vertical) axis along the column.
    if (linePct === undefined) {
      inline = writingMode === "vertical-rl" ? "right" : "left";
    } else if (writingMode === "vertical-rl") {
      inline = linePct < 33 ? "right" : linePct < 66 ? "center" : "left";
    } else {
      inline = linePct < 33 ? "left" : linePct < 66 ? "center" : "right";
    }
    block =
      posPct === undefined
        ? "top"
        : posPct < 33
          ? "top"
          : posPct < 66
            ? "middle"
            : "bottom";
  }

  const textAlign =
    align === "start" || align === "left"
      ? "start"
      : align === "end" || align === "right"
        ? "end"
        : align === "center" || align === "middle"
          ? "center"
          : undefined;

  // Default bottom-center horizontal → no layout (render via the normal main
  // slot), so only genuinely positioned/vertical cues carry layout.
  if (writingMode === "horizontal" && block === "bottom" && inline === "center") {
    return undefined;
  }

  return {
    writingMode,
    block,
    inline,
    ...(textAlign ? { textAlign } : {}),
    ...(region ? { regionId: region } : {}),
  };
}

/** A WebVTT length value → percentage number, dropping Netflix's
    ",alignment" suffix (position:50.00%,middle).  Non-percentage values
    (e.g. an integer `line` number) → undefined (treated as unspecified). */
function pctOf(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const head = v.split(",")[0].trim();
  const m = /^(-?[\d.]+)%$/.exec(head);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

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
    const restTrim = rest.trim();
    const firstSpace = restTrim.search(/\s/);
    const endRaw = firstSpace === -1 ? restTrim : restTrim.slice(0, firstSpace);
    // Everything after the end timestamp is the cue-settings string.
    const settings = firstSpace === -1 ? "" : restTrim.slice(firstSpace + 1);
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

    const layout = parseCueSettings(settings);
    result.push({ start, end, text, ...(layout ? { layout } : {}) });
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}
