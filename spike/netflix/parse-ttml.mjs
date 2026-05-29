// TTML / DFXP → CaptionEvent[] parser for the Netflix port spike (FALLBACK path).
//
// Netflix serves subtitles as either WebVTT (`webvtt-lssdh-ios8`, our primary —
// see parse-vtt.mjs) or TTML/DFXP (`dfxp-ls-sdh`, `imsc1.1`, `simplesdh`).  When
// the capture kit's webvtt-profile injection doesn't take (or a track only
// offers a dfxp profile) we parse TTML.
//
// Output contract is identical to parse-vtt.mjs, but parseTtml ALSO returns an
// `imageBased` flag: some titles (notably CJK / Greek / Hebrew) ship a TTML v2
// IMAGE profile where the cue carries no text — only <image> / backgroundImage
// references to PNG bitmaps.  Those tracks are OCR-only and out of scope for a
// text extension; the production discover path treats imageBased === true as
// "no readable text track for this language" and falls back / warns.
//
//   parseTtml(body) -> { events: CaptionEvent[], imageBased: boolean }
//
// Regex-based on purpose (plain-Node spike, no XML dep).  The production
// lib/captions/netflix/parse-ttml.ts should use DOMParser in the extension.

import { decodeEntities } from "./parse-vtt.mjs";

function attrVal(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
  return m ? m[1] : null;
}

/**
 * TTML time expression → integer milliseconds.
 * Handles: ticks ("64730000t" with ttp:tickRate), offset ("12.5s"/"500ms"/
 * "2m"/"1h"), clock with fraction ("00:00:06.473"), clock with frames
 * ("00:00:06:12" using ttp:frameRate).  Returns null if unparseable.
 */
export function ttmlTimeToMs(value, { tickRate = null, frameRate = 24 } = {}) {
  if (!value) return null;
  const v = String(value).trim();

  let m = /^(\d+(?:\.\d+)?)t$/.exec(v); // ticks
  if (m) {
    if (!tickRate) return null;
    return Math.round((parseFloat(m[1]) / tickRate) * 1000);
  }

  m = /^(\d+(?:\.\d+)?)(h|m|s|ms)$/.exec(v); // offset time
  if (m) {
    const n = parseFloat(m[1]);
    const mult = { h: 3600000, m: 60000, s: 1000, ms: 1 }[m[2]];
    return Math.round(n * mult);
  }

  m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(v); // clock + fraction
  if (m) {
    const [, h, mi, s, frac] = m;
    return (
      ((+h * 60 + +mi) * 60 + +s) * 1000 + parseInt(frac.padEnd(3, "0"), 10)
    );
  }

  m = /^(\d+):(\d{2}):(\d{2}):(\d{1,3})$/.exec(v); // clock + frames
  if (m) {
    const [, h, mi, s, f] = m;
    return Math.round(
      ((+h * 60 + +mi) * 60 + +s) * 1000 + (+f / frameRate) * 1000,
    );
  }

  return null;
}

function cleanTtmlText(inner) {
  return decodeEntities(
    inner.replace(/<(?:[a-z0-9]+:)?br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

export function parseTtml(body) {
  const src = String(body);

  // Image-based subtitle detection: an <image>/smpte:image element, or a
  // backgroundImage attribute, with no extractable <p> text.
  const looksImageBased =
    /<(?:[a-z0-9]+:)?image\b/i.test(src) ||
    /backgroundImage\s*=/i.test(src) ||
    /smpte:image/i.test(src);

  const tickRateM = /tickRate\s*=\s*["'](\d+)["']/i.exec(src);
  const frameRateM = /frameRate\s*=\s*["'](\d+)["']/i.exec(src);
  const tickRate = tickRateM ? parseInt(tickRateM[1], 10) : null;
  const frameRate = frameRateM ? parseInt(frameRateM[1], 10) : 24;

  const result = [];
  const pRe = /<(?:[a-z0-9]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[a-z0-9]+:)?p>/gi;
  let m;
  while ((m = pRe.exec(src)) !== null) {
    const start = ttmlTimeToMs(attrVal(m[1], "begin"), { tickRate, frameRate });
    const end = ttmlTimeToMs(attrVal(m[1], "end"), { tickRate, frameRate });
    if (start === null || end === null) continue;
    const text = cleanTtmlText(m[2]);
    if (text.length === 0) continue;
    result.push({ start, end, text });
  }

  result.sort((a, b) => a.start - b.start);
  return { events: result, imageBased: looksImageBased && result.length === 0 };
}
