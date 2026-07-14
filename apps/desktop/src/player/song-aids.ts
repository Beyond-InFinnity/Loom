// Position-aware reading aids (furigana + romaji) for preserved song lines.
//
// Loom's DOM caption stack can't know where libass draws each animated song
// glyph, so the reading aids for songs are generated as ASS events in libass's
// OWN 1920×1080 coordinate space and handed to mpv alongside the original song
// (songs.ts).  Same renderer, same coordinates → the aids track the lyrics.
//
// The hard part is FURIGANA: placing each reading precisely over its kanji
// needs the base glyph advance, which is font-dependent.  Two things make it
// deterministic:
//   1. Furigana-eligible base lines are PINNED to a known CJK font (\fn), so
//      the advance is a measured constant regardless of the file's embedded
//      fonts (an anime REMUX ships its own OP font — without pinning the
//      furigana would drift on exactly those files).
//   2. Eligibility is gated hard: static (no \move/scale), single line, fully
//      full-width, no inline \fs, and the annotation spans must cover the line
//      exactly.  Anything uncertain gets NO furigana (the romaji line, which
//      is a whole positioned line and needs no per-glyph advance, still shows).
//
// Geometry calibrated against libass (ffmpeg `ass` filter, same engine as mpv)
// for Noto Sans CJK JP — see scratchpad calib2/calib3.  ADV_RATIO and the ink
// offsets are that font's metrics; because we pin the font, they hold on the
// user's machine too.

import type { AnnotateSpan } from "@loom/player-ui/annotate/types";
import type { SongEvent, SongStyleInfo } from "./songs";

// --- calibrated constants (Noto Sans CJK JP via libass) -----------------
/** Full-width glyph advance / fontsize (fontsize × upm/(winAsc+winDesc)). */
const ADV_RATIO = 0.6918;
/** Ink height / fontsize (a full ideograph). */
const INK_H = 0.654;
/** an7/8/9: ink_top = pos.y + this·fs. */
const INK_TOP_FROM_TOPANCHOR = 0.204;
/** an1/2/3: ink_bot = pos.y − this·fs. */
const INK_BOT_FROM_BOTANCHOR = 0.143;

// --- aid layout ---------------------------------------------------------
const FURI_RATIO = 0.5; // furigana fontsize / base fontsize
const ROM_RATIO = 0.56; // romaji fontsize / base fontsize
const FURI_GAP = 0.05; // gap (·fs) between base ink-top and furigana bottom
const ROM_GAP = 0.14; // gap (·fs) above furigana (or ink-top) to romaji bottom

// Pinned base font per script (all Noto CJK share the vertical metrics above,
// so ADV_RATIO/ink offsets are the same).  Furigana READINGS render in a Latin
// or kana face depending on the romanization system.
function pinFontFor(lang: string): string {
  switch (lang) {
    case "zh":
    case "zh-Hans":
      return "Noto Sans CJK SC";
    case "zh-Hant":
    case "yue":
      return "Noto Sans CJK TC";
    case "ko":
      return "Noto Sans CJK KR";
    default:
      return "Noto Sans CJK JP";
  }
}
// Reading face: Japanese furigana is kana (CJK face); pinyin/RR are Latin.
function readingFontFor(lang: string): string {
  return lang === "ja" ? "Noto Sans CJK JP" : "Noto Sans";
}

const FURI_STYLE = "LoomFuri";
const ROM_STYLE = "LoomRom";

function horiz(an: number): "l" | "c" | "r" {
  const m = an % 3;
  return m === 1 ? "l" : m === 2 ? "c" : "r";
}
function isTop(an: number): boolean {
  return an >= 7;
}
function isBottom(an: number): boolean {
  return an >= 1 && an <= 3;
}

/** Full-width cell test — CJK ideographs, kana, CJK punctuation, fullwidth
    forms, and the ideographic space.  A line with any half-width char breaks
    the uniform-advance model, so furigana is skipped for it. */
function isFullWidth(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    c === 0x3000 || // ideographic space
    (c >= 0x3040 && c <= 0x30ff) || // kana
    (c >= 0x3400 && c <= 0x4dbf) || // CJK ext A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK unified
    (c >= 0xf900 && c <= 0xfaff) || // CJK compat
    (c >= 0xff00 && c <= 0xff60) || // fullwidth forms
    (c >= 0xffe0 && c <= 0xffe6) || // fullwidth signs
    (c >= 0x3000 && c <= 0x303f) || // CJK symbols & punct
    (c >= 0xac00 && c <= 0xd7a3) // hangul syllables
  );
}

interface Anchor {
  x: number;
  y: number;
  an: number;
}

/** Resolve a song line's effective anchor point (\pos + \an, else style
    alignment + margins).  Null when unresolvable (no usable geometry). */
function resolveAnchor(
  s: SongEvent,
  style: SongStyleInfo | undefined,
  playResX: number,
  playResY: number,
): Anchor | null {
  const an = s.an ?? style?.alignment ?? 2;
  if (s.pos) return { x: s.pos.x, y: s.pos.y, an };
  // Style-anchored: derive from alignment + margins (single centered lyric
  // line is the reliable case; long wrapping lines are gated out elsewhere).
  const mL = s.marginL || style?.marginL || 0;
  const mR = s.marginR || style?.marginR || 0;
  const mV = s.marginV || style?.marginV || 0;
  const h = horiz(an);
  const x = h === "l" ? mL : h === "r" ? playResX - mR : playResX / 2;
  const y = isTop(an) ? mV : isBottom(an) ? playResY - mV : playResY / 2;
  return { x, y, an };
}

/** ink-top Y of the base line for a given anchor. */
function inkTop(an: number, y: number, fs: number): number {
  if (isTop(an)) return y + INK_TOP_FROM_TOPANCHOR * fs;
  if (isBottom(an)) return y - INK_BOT_FROM_BOTANCHOR * fs - INK_H * fs;
  return y - (INK_H / 2) * fs; // mid
}

/** Left edge (x of cell 0) for a full-width line of `cells` glyphs. */
function leftEdge(a: Anchor, cells: number, adv: number): number {
  const w = cells * adv;
  const h = horiz(a.an);
  return h === "l" ? a.x : h === "r" ? a.x - w : a.x - w / 2;
}

/** Horizontal center of the base line (for the romaji line). */
function centerX(a: Anchor, cells: number, adv: number): number {
  const w = cells * adv;
  const h = horiz(a.an);
  return h === "l" ? a.x + w / 2 : h === "r" ? a.x - w / 2 : a.x;
}

function round(n: number): number {
  return Math.round(n);
}

/** Does the line have geometry we won't get right — scaling / per-syllable
    font-size / rotation?  (Motion is handled separately via s.hasMotion.) */
function hasScaleOrFs(raw: string): boolean {
  return /\\fs\d|\\fscx|\\fscy|\\frx|\\fry|\\frz|\\fr\b/.test(raw);
}

/** Inject a pinned font at the very start of a Dialogue line's Text field so
    the base advance is the measured constant.  Keeps every other tag intact
    (karaoke \k, colour sweeps, \pos) — only the typeface is fixed. */
function pinFontInLine(rawLine: string, font: string): string {
  // Text is everything after the 9th comma (Layer,Start,End,Style,Name,
  // MarginL,MarginR,MarginV,Effect,Text).
  const parts = rawLine.split(",");
  if (parts.length < 10) return rawLine;
  const head = parts.slice(0, 9).join(",");
  const text = parts.slice(9).join(",");
  return `${head},{\\fn${font}}${text}`;
}

export interface SongAidsInput {
  /** The chosen-language song lines (already filtered) to annotate. */
  chosen: SongEvent[];
  styles: Map<string, SongStyleInfo>;
  /** trimmed plainText → full romanization (from /romanize/batch). */
  romajiMap: Map<string, string>;
  /** trimmed plainText → annotation spans (from /annotate/batch). */
  spansMap: Map<string, AnnotateSpan[]>;
  playResX: number;
  playResY: number;
  /** Display language of the chosen songs (ja / zh / zh-Hant / ko / …). */
  lang: string;
  /** Base font family → its measured libass advance ratio (fullwidth advance /
      fontsize), from the font-metrics probe.  When a line's base font is here,
      furigana aligns in the ORIGINAL typeface (no pin); when absent, the Noto
      constant + a \fn pin keep the geometry deterministic. */
  advanceRatios: Map<string, number>;
}

export interface SongAidsOptions {
  romaji: boolean;
  furigana: boolean;
}

export interface SongAids {
  /** The chosen song Dialogue lines, with \fn pinned on furigana-eligible
      lines (verbatim otherwise).  Pass as the songs-only .ass song lines. */
  rawLines: string[];
  extraStyles: string[];
  extraEvents: string[];
}

/** Build the furigana + romaji ASS aids for a set of chosen song lines. */
export function buildSongAids(
  input: SongAidsInput,
  opts: SongAidsOptions,
): SongAids {
  const { chosen, styles, romajiMap, spansMap, playResX, playResY, lang, advanceRatios } =
    input;
  const base = (lang || "").toLowerCase().split("-")[0];
  const canFurigana =
    opts.furigana && (base === "ja" || base === "zh" || base === "ko");

  const rawLines: string[] = [];
  const extraEvents: string[] = [];

  for (const s of chosen) {
    const style = styles.get(s.styleName);
    const fs = style?.fontSize || 48;
    const plain = s.plainText.trim();
    const multiLine = /\n/.test(s.plainText);
    const anchor = resolveAnchor(s, style, playResX, playResY);

    // --- furigana eligibility (strict) ---
    const cells = [...plain];
    const fullWidth = cells.length > 0 && cells.every(isFullWidth);
    const spans = spansMap.get(plain) ?? null;
    const spanCells = spans
      ? spans.reduce((n, sp) => n + [...sp.base].length, 0)
      : 0;
    const furiEligible =
      canFurigana &&
      !!anchor &&
      !s.hasMotion &&
      !multiLine &&
      fullWidth &&
      !hasScaleOrFs(s.rawText) &&
      !!spans &&
      spanCells === cells.length &&
      spans.some((sp) => sp.reading && sp.reading.trim().length > 0);

    // Advance for THIS line's base font: the real font's measured ratio when we
    // could resolve it (furigana aligns in the ORIGINAL typeface, no pin), else
    // the Noto constant with a pin so the geometry stays deterministic.
    const fontRatio = style ? advanceRatios.get(style.fontName) ?? null : null;
    const pinBase = fontRatio == null;
    const adv = (fontRatio ?? ADV_RATIO) * fs;

    // Pin the base font ONLY when placing furigana AND its real ratio is unknown
    // (unknown ratio → we must force a known metric for alignment).
    if (furiEligible && pinBase) {
      rawLines.push(pinFontInLine(s.rawLine, pinFontFor(lang)));
    } else {
      rawLines.push(s.rawLine);
    }

    if (!anchor || s.hasMotion || multiLine) continue; // no aids on this line

    const top = inkTop(anchor.an, anchor.y, fs);

    // --- furigana events ---
    let furiPlaced = false;
    if (furiEligible && spans) {
      const le = leftEdge(anchor, cells.length, adv);
      const furiBottom = top - FURI_GAP * fs;
      let cell = 0;
      for (const sp of spans) {
        const len = [...sp.base].length;
        const reading = sp.reading?.trim();
        if (reading) {
          const cx = le + (cell + len / 2) * adv;
          extraEvents.push(
            dialogue(
              s.start,
              s.end,
              FURI_STYLE,
              `{\\an2\\pos(${round(cx)},${round(furiBottom)})}${reading}`,
            ),
          );
          furiPlaced = true;
        }
        cell += len;
      }
    }

    // --- romaji line ---
    if (opts.romaji) {
      const romaji = romajiMap.get(plain);
      if (romaji) {
        const cx = centerX(anchor, cells.length, adv);
        const romBottom = furiPlaced
          ? top - FURI_GAP * fs - FURI_RATIO * fs - ROM_GAP * fs
          : top - ROM_GAP * fs;
        extraEvents.push(
          dialogue(
            s.start,
            s.end,
            ROM_STYLE,
            `{\\an2\\pos(${round(cx)},${round(romBottom)})}${romaji}`,
          ),
        );
      }
    }
  }

  const extraStyles = extraEvents.length
    ? styleLines(chosen, styles, lang)
    : [];

  return { rawLines, extraStyles, extraEvents };
}

function dialogue(
  start: number,
  end: number,
  style: string,
  text: string,
): string {
  return `Dialogue: 0,${msToAss(start)},${msToAss(end)},${style},,0,0,0,,${text}`;
}

/** Style lines for the aids — sized off the median song fontsize so they
    scale with the lyrics. */
function styleLines(
  chosen: SongEvent[],
  styles: Map<string, SongStyleInfo>,
  lang: string,
): string[] {
  const sizes = chosen
    .map((s) => styles.get(s.styleName)?.fontSize || 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const fs = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 48;
  const furiFs = Math.max(10, Math.round(FURI_RATIO * fs));
  const romFs = Math.max(12, Math.round(ROM_RATIO * fs));
  const furiFont = readingFontFor((lang || "").toLowerCase().split("-")[0]);
  // Furigana: soft blue-white, thin outline.  Romaji: warm mint, italic.
  return [
    `Style: ${FURI_STYLE},${furiFont},${furiFs},&H00F0F5FF,&H000000FF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,1.2,0,2,10,10,10,1`,
    `Style: ${ROM_STYLE},Noto Sans,${romFs},&H00C8FFE0,&H000000FF,&H00202020,&H80000000,0,-1,0,0,100,100,0,0,1,1.4,0,2,10,10,10,1`,
  ];
}

function msToAss(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p2(m)}:${p2(s)}.${p2(c)}`;
}
