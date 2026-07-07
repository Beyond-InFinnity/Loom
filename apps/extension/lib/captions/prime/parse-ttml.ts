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

import type { CaptionEvent, CueLayout, WritingMode } from "../types";

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

// ---- Layout / region extraction (non-destructive positional parse) -------
//
// Prime's TTML defines regions in <head><layout>, e.g. (real, Evangelion):
//   <region tts:displayAlign="after" tts:extent="80vw 15vh" xml:id="横下" />
//   <region tts:extent="15vw 80vh" tts:writingMode="tbrl"  xml:id="縦右" />
// and cues reference one via `region=` on <p> (or inherit <body region=>).
// The region carries orientation (tts:writingMode) + placement
// (tts:origin/extent/displayAlign); the id is a JP mnemonic (横=horizontal /
// 縦=vertical, 上/中/下 = top/mid/bottom, 左/中/右 = left/center/right) we use
// as a fallback when coordinates are absent.  We resolve each cue to a
// CueLayout so the overlay can reproduce vertical / positioned cues instead
// of flattening them.

interface RegionDef {
  writingMode?: string;
  origin?: string;
  extent?: string;
  displayAlign?: string;
  textAlign?: string;
}

/** Extract an attribute value from a raw tag/attr string (colon-safe). */
function attrOf(s: string, name: string): string | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\s)${esc}\\s*=\\s*"([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
}

/** regionId → definition, parsed from <head><layout>.  Empty when the
    document defines no regions (plain TTML → cues get no layout). */
function parseRegions(doc: string): Map<string, RegionDef> {
  const map = new Map<string, RegionDef>();
  const layout = /<layout\b[^>]*>([^]*?)<\/layout>/i.exec(doc);
  if (!layout) return map;
  for (const tag of layout[1].match(/<region\b[^>]*\/?>/g) ?? []) {
    const id = attrOf(tag, "xml:id");
    if (!id) continue;
    map.set(id, {
      writingMode: attrOf(tag, "tts:writingMode"),
      origin: attrOf(tag, "tts:origin"),
      extent: attrOf(tag, "tts:extent"),
      displayAlign: attrOf(tag, "tts:displayAlign"),
      textAlign: attrOf(tag, "tts:textAlign"),
    });
  }
  return map;
}

function writingModeOf(wm?: string): WritingMode {
  const v = (wm ?? "").toLowerCase();
  if (v.startsWith("tblr")) return "vertical-lr";
  if (v.startsWith("tbrl") || v === "tb") return "vertical-rl";
  return "horizontal";
}

/** "80vw 15vh" / "10% 82%" → { a, b } as [0..1] fractions.  px is
    un-normalizable without the frame size → undefined. */
function parseLenPair(s?: string): { a: number; b: number } | undefined {
  if (!s) return undefined;
  const m = s
    .trim()
    .match(/^(-?[\d.]+)(vw|vh|%|px|c)?\s+(-?[\d.]+)(vw|vh|%|px|c)?$/i);
  if (!m) return undefined;
  if ((m[2] ?? "").toLowerCase() === "px" || (m[4] ?? "").toLowerCase() === "px") {
    return undefined;
  }
  const a = parseFloat(m[1]) / 100;
  const b = parseFloat(m[3]) / 100;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { a, b };
}

/** Decode the JP position mnemonic in a region id, orientation-aware:
    for horizontal regions 中 means the middle ROW; for vertical it means
    the center COLUMN. */
function mnemonicZone(
  id: string | undefined,
  vertical: boolean,
): { block?: CueLayout["block"]; inline?: CueLayout["inline"] } {
  if (!id) return {};
  const out: { block?: CueLayout["block"]; inline?: CueLayout["inline"] } = {};
  if (id.includes("上")) out.block = "top";
  if (id.includes("下")) out.block = "bottom";
  if (id.includes("左")) out.inline = "left";
  if (id.includes("右")) out.inline = "right";
  if (id.includes("中") || id.includes("央")) {
    if (vertical) out.inline = "center";
    else out.block = "middle";
  }
  return out;
}

/** Resolve a cue's region reference → CueLayout, or undefined when the
    cue references no defined region (→ overlay default placement). */
function resolveLayout(
  regions: Map<string, RegionDef>,
  regionId: string | undefined,
): CueLayout | undefined {
  if (!regionId) return undefined;
  const def = regions.get(regionId);
  if (!def) return undefined;

  const writingMode = writingModeOf(def.writingMode);
  const vertical = writingMode !== "horizontal";
  const o = parseLenPair(def.origin);
  const e = parseLenPair(def.extent);
  const origin = o ? { x: o.a, y: o.b } : undefined;
  const extent = e ? { w: e.a, h: e.b } : undefined;
  const mnem = mnemonicZone(regionId, vertical);

  // Block (vertical zone): precise center → displayAlign → mnemonic →
  // orientation default (horizontal captions sit bottom; vertical columns
  // start at top).
  let block: CueLayout["block"];
  if (origin && extent) {
    const cy = origin.y + extent.h / 2;
    block = cy < 0.4 ? "top" : cy < 0.66 ? "middle" : "bottom";
  } else if (def.displayAlign) {
    const da = def.displayAlign.toLowerCase();
    block = da === "before" ? "top" : da === "center" ? "middle" : "bottom";
  } else {
    block = mnem.block ?? (vertical ? "top" : "bottom");
  }

  // Inline (horizontal zone): precise center → mnemonic → orientation
  // default (horizontal captions center; vertical columns sit right).
  let inline: CueLayout["inline"];
  if (origin && extent) {
    const cx = origin.x + extent.w / 2;
    inline = cx < 0.4 ? "left" : cx < 0.66 ? "center" : "right";
  } else {
    inline = mnem.inline ?? (vertical ? "right" : "center");
  }

  const ta = (def.textAlign ?? "").toLowerCase();
  const textAlign =
    ta === "start" || ta === "left"
      ? "start"
      : ta === "center"
        ? "center"
        : ta === "end" || ta === "right"
          ? "end"
          : undefined;

  return {
    writingMode,
    block,
    inline,
    ...(textAlign ? { textAlign } : {}),
    ...(origin ? { origin } : {}),
    ...(extent ? { extent } : {}),
    regionId,
  };
}

/** Parse a full TTML2 document body → CaptionEvent[]. */
export function parseTtml(body: string): CaptionEvent[] {
  const doc = String(body);
  const rubyTextIds = rubyTextStyleIds(doc);
  const regions = parseRegions(doc);
  const bodyTag = /<body\b([^>]*)>/i.exec(doc);
  const bodyRegion = bodyTag ? attrOf(bodyTag[1], "region") : undefined;
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

    // Cue region: own `region=` attr, else inherit <body region=>.  (A
    // <div region=> level exists in the spec but Prime doesn't use it.)
    const regionId = attrOf(attrs, "region") ?? bodyRegion;
    const layout = resolveLayout(regions, regionId);

    result.push({ start, end, text, ...(layout ? { layout } : {}) });
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}
