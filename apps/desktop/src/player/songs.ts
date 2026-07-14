// Song-line preservation for the Loom Player.
//
// Fansub OP/ED/insert lyrics are animated ASS (per-syllable \k karaoke,
// \pos'd stacked romaji+kanji lines, colour sweeps).  Loom's DOM caption
// path flattens every event to plain text — which DESTROYS that animation.
// Instead we split the target track's ASS in two:
//
//   • DIALOGUE styles  → parsed CaptionEvent[] for Loom's DOM captions
//                        (full Top/Bottom/annotation/romaji/gloss stack).
//   • SONG styles      → a songs-only .ass (original [Script Info] + styles
//                        + song events VERBATIM) handed to mpv/libass, so the
//                        animation renders exactly as authored.
//
// The DOM layer can't know where libass draws each animated glyph, so the
// Loom reading aids for songs (romaji line, furigana) are generated as ASS
// too (S2/S3) — same renderer, same 1920×1080 coordinate space — rather than
// as DOM.  This module owns the split + the per-song metadata those aids need.
//
// Signs / typesetting / staff credits are deliberately LEFT on the DOM path
// for now (this is scoped to sung lyrics); routing them to libass too is a
// clean follow-up.

import type { CaptionEvent } from "@loom/player-ui/captions/types";
import { classifyLine, type SplitLang } from "./subs-split";

// Sung-lyric style names — the lyric subset of the Python engine's
// _PRESERVE_PATTERNS (loom_core/subs/processing.py).  "romaji"/"kanji" are
// near-universal fansub OP/ED lyric-style names.  Signs/typeset/staff/notes
// are intentionally excluded here.
const SONG_STYLE_RE =
  /song|lyric|karaoke|kfx|opening|ending|insert|romaji|kanji|\bop\b|op_|_op|\bed\b|ed_|_ed/i;

// A song event that made mpv's cut, with the metadata the aid generators need.
export interface SongEvent {
  start: number;
  end: number;
  /** Original ASS text, tags intact. */
  rawText: string;
  /** Tags stripped — for /annotate + /romanize. */
  plainText: string;
  styleName: string;
  /** Script-classified language of this line (ja/zh/ko/en/other). */
  lang: SplitLang;
  /** The full original `Dialogue:` line, for rebuilding the songs-only .ass. */
  rawLine: string;
  /** Explicit \pos(x,y) in PlayRes coords, or null (style-anchored). */
  pos: { x: number; y: number } | null;
  /** \anN alignment override, or null. */
  an: number | null;
  /** \move / scale / rotate / shear present → glyphs move; aids would drift. */
  hasMotion: boolean;
  /** Per-event margins (0 = fall back to the style's), for aid anchoring. */
  marginL: number;
  marginR: number;
  marginV: number;
}

export interface SongStyleInfo {
  name: string;
  fontName: string;
  fontSize: number;
  /** Style's default \anN alignment (1–9). */
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

export interface SongSplit {
  /** All parsed song events, each tagged with its language + raw line. */
  songs: SongEvent[];
  /** Style name → font/alignment (for furigana positioning). */
  styles: Map<string, SongStyleInfo>;
  /** Song style name → its DOMINANT line language.  A song is selected by its
      style's language as a whole, so mixed-language lyrics (a JP song with a
      few English lines) stay together instead of splitting. */
  styleLangs: Map<string, SplitLang>;
  playResX: number;
  playResY: number;
  /** Build a songs-only .ass from a chosen subset of song `Dialogue:` lines
      (e.g. one language's), optionally with extra style/event lines (aids). */
  buildSongsAss: (
    rawLines: string[],
    extraStyles?: string[],
    extraEvents?: string[],
  ) => string;
}

const EVENTS_DEFAULT = [
  "Layer", "Start", "End", "Style", "Name",
  "MarginL", "MarginR", "MarginV", "Effect", "Text",
];
const STYLES_DEFAULT = [
  "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour",
  "OutlineColour", "BackColour", "Bold", "Italic", "Underline", "StrikeOut",
  "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle", "Outline", "Shadow",
  "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
];

/** `H:MM:SS.cc` → ms, or null. */
function assTimeMs(s: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})[.:](\d{2})$/.exec(s.trim());
  if (!m) return null;
  return (
    Number(m[1]) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4]) * 10
  );
}

/** Strip override blocks + drawing; \N/\n → newline; \h → space. */
function cleanAss(raw: string): string {
  let s = raw.replace(/\{[^}]*\}/g, "");
  s = s.replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ");
  return s.trim();
}

/** Field-name → column index from a section's `Format:` line (or a fallback). */
function fieldMap(
  lines: string[],
  fallback: string[],
): { idx: Record<string, number>; count: number } {
  const fmt = lines.find((l) => /^\s*Format:/i.test(l));
  const names = fmt
    ? fmt.slice(fmt.indexOf(":") + 1).split(",").map((s) => s.trim())
    : fallback;
  const idx: Record<string, number> = {};
  names.forEach((n, i) => {
    idx[n] = i;
  });
  return { idx, count: names.length };
}

/** Split a `Dialogue:`/`Style:` body into exactly `n` fields — the last field
    (Text) keeps its internal commas. */
function splitFields(body: string, n: number): string[] | null {
  const parts = body.split(",");
  if (parts.length < n) return null;
  const head = parts.slice(0, n - 1);
  const last = parts.slice(n - 1).join(",");
  return [...head, last];
}

function readInt(lines: string[], key: string): number | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(-?\\d+)`, "i");
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}

function readPos(raw: string): { x: number; y: number } | null {
  const m = /\\pos\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(raw);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function readAn(raw: string): number | null {
  const m = /\\an([1-9])/.exec(raw);
  return m ? Number(m[1]) : null;
}

// Motion = the glyphs physically move/scale/rotate, so statically-placed aids
// would drift.  A \k karaoke sweep or a colour/alpha \t does NOT move glyphs.
function detectMotion(raw: string): boolean {
  if (/\\move\b/.test(raw)) return true;
  // \t(...) that animates scale / rotation / shear (not colour/alpha/blur).
  return /\\t\s*\([^)]*\\(?:fsc[xy]|fr[xyz]|fr\b|fa[xy])/.test(raw);
}

/** Parse an ASS document into its named sections (body lines, headers dropped). */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (m) {
      cur = [];
      out.set(m[1], cur);
      continue;
    }
    if (cur) cur.push(line);
  }
  return out;
}

/** Split a target-track ASS into a Loom-DOM dialogue stream + a songs-only
    ASS (or null when there are no song-styled events / it isn't ASS). */
export function splitAssSongs(assText: string): SongSplit {
  const text = assText.replace(/^﻿/, "");
  const secs = sections(text);
  const scriptInfo = secs.get("Script Info") ?? [];
  const stylesKey = [...secs.keys()].find((k) => /Styles/i.test(k)) ?? "V4+ Styles";
  const stylesLines = secs.get(stylesKey) ?? [];
  const eventsLines = secs.get("Events") ?? [];

  const playResX = readInt(scriptInfo, "PlayResX") ?? 1920;
  const playResY = readInt(scriptInfo, "PlayResY") ?? 1080;

  // Styles → font/alignment + song classification.
  const styleFmt = fieldMap(stylesLines, STYLES_DEFAULT);
  const styles = new Map<string, SongStyleInfo>();
  const songStyleNames = new Set<string>();
  for (const l of stylesLines) {
    if (!/^\s*Style\s*:/i.test(l)) continue;
    const parts = splitFields(l.slice(l.indexOf(":") + 1), styleFmt.count);
    if (!parts) continue;
    const name = (parts[styleFmt.idx["Name"]] ?? "").trim();
    if (!name) continue;
    styles.set(name, {
      name,
      fontName: (parts[styleFmt.idx["Fontname"]] ?? "").trim(),
      fontSize: Number((parts[styleFmt.idx["Fontsize"]] ?? "").trim()) || 0,
      alignment: Number((parts[styleFmt.idx["Alignment"]] ?? "").trim()) || 2,
      marginL: Number((parts[styleFmt.idx["MarginL"]] ?? "").trim()) || 0,
      marginR: Number((parts[styleFmt.idx["MarginR"]] ?? "").trim()) || 0,
      marginV: Number((parts[styleFmt.idx["MarginV"]] ?? "").trim()) || 0,
    });
    if (SONG_STYLE_RE.test(name)) songStyleNames.add(name);
  }

  // Events → dialogue (DOM) vs song (libass).
  const evFmt = fieldMap(eventsLines, EVENTS_DEFAULT);
  const eventsFormat =
    eventsLines.find((l) => /^\s*Format\s*:/i.test(l))?.trim() ??
    `Format: ${EVENTS_DEFAULT.join(", ")}`;

  // Only SONG events are collected here; dialogue is handled by the caller
  // (it filters the target track's OWN language-split events by song timing,
  // since the raw ASS may be bilingual — see main.tsx).
  const songs: SongEvent[] = [];
  const styleLangTally = new Map<string, Map<SplitLang, number>>();

  for (const l of eventsLines) {
    if (!/^\s*Dialogue\s*:/i.test(l)) continue;
    const parts = splitFields(l.slice(l.indexOf(":") + 1), evFmt.count);
    if (!parts) continue;
    const styleName = (parts[evFmt.idx["Style"]] ?? "").trim();
    if (!songStyleNames.has(styleName)) continue;
    const rawText = parts[evFmt.idx["Text"]] ?? "";
    const start = assTimeMs(parts[evFmt.idx["Start"]] ?? "");
    const end = assTimeMs(parts[evFmt.idx["End"]] ?? "");
    if (start === null || end === null || end <= start) continue;
    const plainText = cleanAss(rawText);
    const lang = classifyLine(plainText);
    songs.push({
      start,
      end,
      rawText,
      plainText,
      styleName,
      lang,
      rawLine: l,
      pos: readPos(rawText),
      an: readAn(rawText),
      hasMotion: detectMotion(rawText),
      marginL: Number((parts[evFmt.idx["MarginL"]] ?? "").trim()) || 0,
      marginR: Number((parts[evFmt.idx["MarginR"]] ?? "").trim()) || 0,
      marginV: Number((parts[evFmt.idx["MarginV"]] ?? "").trim()) || 0,
    });
    const tally = styleLangTally.get(styleName) ?? new Map<SplitLang, number>();
    tally.set(lang, (tally.get(lang) ?? 0) + 1);
    styleLangTally.set(styleName, tally);
  }

  songs.sort((a, b) => a.start - b.start);

  // Dominant language per song style (ignoring "other"); a whole song style is
  // then chosen/suppressed as a unit.
  const styleLangs = new Map<string, SplitLang>();
  for (const [style, tally] of styleLangTally) {
    const best = [...tally.entries()]
      .filter(([l]) => l !== "other")
      .sort((a, b) => b[1] - a[1])[0];
    styleLangs.set(style, best ? best[0] : "other");
  }

  const buildSongsAss = (
    rawLines: string[],
    extraStyles: string[] = [],
    extraEvents: string[] = [],
  ): string =>
    assembleSongsAss(
      scriptInfo,
      stylesKey,
      stylesLines,
      eventsFormat,
      rawLines,
      extraStyles,
      extraEvents,
    );

  return { songs, styles, styleLangs, playResX, playResY, buildSongsAss };
}

/** Choose the ONE song language to display: prefer the study/target language
    (annotatable), then the user's language, else the most common song
    language present.  (English users studying Japanese → JP song over the CH
    translation; an English-only release → the English song.)  Songs are
    grouped by their STYLE's dominant language so a mixed-language song stays
    whole. */
export function chooseSongLang(
  songs: SongEvent[],
  styleLangs: Map<string, SplitLang>,
  targetBase: string,
  nativeBase: string,
): SplitLang {
  const counts = new Map<SplitLang, number>();
  for (const s of songs) {
    const l = styleLangs.get(s.styleName) ?? s.lang;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const has = (l: string): l is SplitLang => counts.has(l as SplitLang);
  if (has(targetBase)) return targetBase;
  if (has(nativeBase)) return nativeBase;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ---- "Original subtitles" mode (Loom off, plain player) ----------------

/** Rebuild an ORIGINAL .ass keeping only the events whose style's dominant
    language is in `langs` — the whole original track (dialogue + songs) in one
    language, with its authentic styles/animation intact.  Used by the player's
    "Original subtitles → Video / Your language" modes.  Null if nothing matches. */
export function buildOriginalAss(
  rawAss: string,
  langs: SplitLang[],
): string | null {
  const text = rawAss.replace(/^﻿/, "");
  const secs = sections(text);
  const scriptInfo = secs.get("Script Info") ?? [];
  const stylesKey =
    [...secs.keys()].find((k) => /Styles/i.test(k)) ?? "V4+ Styles";
  const stylesLines = secs.get(stylesKey) ?? [];
  const eventsLines = secs.get("Events") ?? [];
  const evFmt = fieldMap(eventsLines, EVENTS_DEFAULT);
  const eventsFormat =
    eventsLines.find((l) => /^\s*Format\s*:/i.test(l))?.trim() ??
    `Format: ${EVENTS_DEFAULT.join(", ")}`;

  // Dominant language per style, over ALL dialogue events.
  const tally = new Map<string, Map<SplitLang, number>>();
  const rows: { line: string; style: string }[] = [];
  for (const l of eventsLines) {
    if (!/^\s*Dialogue\s*:/i.test(l)) continue;
    const parts = splitFields(l.slice(l.indexOf(":") + 1), evFmt.count);
    if (!parts) continue;
    const style = (parts[evFmt.idx["Style"]] ?? "").trim();
    const lang = classifyLine(cleanAss(parts[evFmt.idx["Text"]] ?? ""));
    const t = tally.get(style) ?? new Map<SplitLang, number>();
    t.set(lang, (t.get(lang) ?? 0) + 1);
    tally.set(style, t);
    rows.push({ line: l, style });
  }
  const styleLang = new Map<string, SplitLang>();
  for (const [style, t] of tally) {
    const best = [...t.entries()]
      .filter(([l]) => l !== "other")
      .sort((a, b) => b[1] - a[1])[0];
    styleLang.set(style, best ? best[0] : "other");
  }
  const wanted = new Set(langs);
  const kept = rows
    .filter((r) => wanted.has(styleLang.get(r.style) ?? "other"))
    .map((r) => r.line);
  if (kept.length === 0) return null;
  return assembleSongsAss(scriptInfo, stylesKey, stylesLines, eventsFormat, kept);
}

/** `ms` → ASS `H:MM:SS.cc`. */
function msToAssTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p2(m)}:${p2(s)}.${p2(c)}`;
}

/** A minimal white-on-outline .ass from plain caption events — for original
    SRT/VTT tracks that carry no styling of their own. */
export function buildPlainAss(events: CaptionEvent[]): string | null {
  if (events.length === 0) return null;
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2.5,1,2,80,80,46,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = events.map(
    (e) =>
      `Dialogue: 0,${msToAssTime(e.start)},${msToAssTime(e.end)},Default,,0,0,0,,` +
      e.text.replace(/\r?\n/g, "\\N"),
  );
  return [...head, ...lines, ""].join("\n");
}

/** Rebuild a minimal, self-contained songs-only .ass: original Script Info +
    styles VERBATIM (so coordinates + fonts match), song events only.  Extra
    aid events (S2/S3) are appended to `extraStyles`/`extraEvents`. */
export function assembleSongsAss(
  scriptInfo: string[],
  stylesKey: string,
  stylesLines: string[],
  eventsFormat: string,
  songLines: string[],
  extraStyles: string[] = [],
  extraEvents: string[] = [],
): string {
  const nonEmpty = (arr: string[]) => arr.filter((l) => l.trim() !== "");
  const out: string[] = [];
  out.push("[Script Info]");
  out.push(...nonEmpty(scriptInfo));
  out.push("");
  out.push(`[${stylesKey}]`);
  out.push(...nonEmpty(stylesLines));
  out.push(...extraStyles);
  out.push("");
  out.push("[Events]");
  out.push(eventsFormat);
  out.push(...songLines);
  out.push(...extraEvents);
  out.push("");
  return out.join("\n");
}
