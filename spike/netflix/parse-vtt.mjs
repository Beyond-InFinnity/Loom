// WebVTT → CaptionEvent[] parser for the Netflix port spike.
//
// Output contract mirrors apps/extension/lib/captions/fanout.ts::parseJson3
// EXACTLY, so the rest of the pipeline (stream.ts playhead lookup,
// caption-overlay render) consumes Netflix cues identically to YouTube
// events:
//
//   CaptionEvent = { start: number /*ms*/, end: number /*ms*/, text: string }
//     - times in integer milliseconds
//     - text trimmed; inline tags + HTML entities stripped; empty cues dropped
//     - result sorted ascending by start
//
// WebVTT is the PRIMARY Netflix format for our purposes: the capture kit
// forces it by injecting the `webvtt-lssdh-ios8` profile into the manifest
// request (see capture-kit.js).  TTML/DFXP is the fallback (parse-ttml.mjs).
//
// This is a spike seed for the production lib/captions/netflix/parse-vtt.ts.
// In the extension, prefer the browser-native VTTCue path or a real parser;
// this regex parser exists to validate the format end-to-end in plain Node.

const NAMED = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&lrm;": "", // LEFT-TO-RIGHT MARK — bidi control, drop
  "&rlm;": "", // RIGHT-TO-LEFT MARK — bidi control, drop
};

function safeCp(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Decode the small set of HTML entities Netflix VTT/TTML actually emits. */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => safeCp(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCp(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (e) => NAMED[e.toLowerCase()] ?? "");
}

/** Strip inline tags (<i>, <c.bg_transparent>, <00:00:00.000>…) + entities. */
export function cleanText(raw) {
  return decodeEntities(raw.replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+/g, " ")
    .trim();
}

const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** "HH:MM:SS.mmm" or "MM:SS.mmm" → integer milliseconds (null if unparseable). */
export function vttTimeToMs(stamp) {
  const m = TIMESTAMP.exec(String(stamp).trim());
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  const millis = parseInt(m[4].padEnd(3, "0"), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** Parse a full WebVTT document body → CaptionEvent[]. */
export function parseVtt(body) {
  const result = [];
  const blocks = String(body)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n");
    // The cue's timing line is the one containing "-->".  Anything before it
    // in the block is an optional cue identifier; STYLE/REGION/NOTE/the WEBVTT
    // header blocks have no "-->" and are skipped.
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
