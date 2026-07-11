// Events-only subtitle parser for the native players' CaptionTrackSource
// (7c, MOBILE_ROADMAP.md): a demuxed .ass / .srt track text → CaptionEvent[]
// (start/end ms + plain text).  Deliberately NOT a full SSA implementation —
// styles/positioning are irrelevant here because the VIDEO-side rendering is
// libass (mpv) drawing Loom's generated 4-layer .ass; these events only feed
// the playhead-synced gloss loop (current line → tokens → definition card).
// The Python engine (pysubs2) and apps/web/lib/subs stay the authorities for
// generation; don't grow this into one.

import type { CaptionEvent } from "../captions/types";

/** Sniff + parse.  Returns events sorted by start; [] for unrecognized. */
export function parseSubtitleEvents(text: string): CaptionEvent[] {
  const t = text.replace(/^﻿/, "");
  if (/^\s*\[Script Info\]/im.test(t) || /^\s*Dialogue:/m.test(t)) {
    return parseAssEvents(t);
  }
  if (/^\s*WEBVTT/.test(t)) {
    return parseVttEvents(t);
  }
  return parseSrtEvents(t);
}

// ---- ASS -------------------------------------------------------------

/** `H:MM:SS.cc` → ms. */
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

/** Strip override tags + drawing blocks; \N/\n → newline; \h → space. */
function cleanAssText(raw: string): string {
  let s = raw.replace(/\{[^}]*\}/g, "");
  s = s.replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ");
  return s.trim();
}

function parseAssEvents(t: string): CaptionEvent[] {
  // Field order comes from the [Events] Format: line; fall back to the
  // pysubs2 default when absent.
  let fields = [
    "Layer", "Start", "End", "Style", "Name",
    "MarginL", "MarginR", "MarginV", "Effect", "Text",
  ];
  const fmt = /^Format:\s*(.+)$/m.exec(
    t.split(/^\[Events\]/m)[1] ?? "",
  );
  if (fmt) fields = fmt[1].split(",").map((f) => f.trim());
  const startIdx = fields.indexOf("Start");
  const endIdx = fields.indexOf("End");
  const textIdx = fields.indexOf("Text");
  if (startIdx < 0 || endIdx < 0 || textIdx < 0) return [];

  const out: CaptionEvent[] = [];
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const body = line.slice("Dialogue:".length);
    // Text is the LAST field and may contain commas: split only the
    // leading fields, keep the remainder intact.
    const parts = body.split(",");
    if (parts.length < fields.length) continue;
    const head = parts.slice(0, fields.length - 1);
    const rawText = parts.slice(fields.length - 1).join(",");
    const start = assTimeMs(head[startIdx] ?? "");
    const end = assTimeMs(head[endIdx] ?? "");
    if (start === null || end === null || end <= start) continue;
    // Drawing-mode events (\p1 vector art) are not dialogue.
    if (/\{[^}]*\\p[1-9]/.test(rawText)) continue;
    const text = cleanAssText(rawText);
    if (!text) continue;
    out.push({ start, end, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- SRT / VTT -------------------------------------------------------

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` → ms. */
function cueTimeMs(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{3})$/.exec(s.trim());
  if (!m) return null;
  return (
    Number(m[1] ?? 0) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4])
  );
}

function stripMarkup(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function parseCueBlocks(t: string): CaptionEvent[] {
  const out: CaptionEvent[] = [];
  for (const block of t.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx < 0) continue;
    const [rawStart, rawRest] = lines[timeLineIdx].split("-->");
    const start = cueTimeMs(rawStart ?? "");
    // VTT cue settings may trail the end time — take the first token.
    const end = cueTimeMs((rawRest ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    const text = stripMarkup(lines.slice(timeLineIdx + 1).join("\n"));
    if (!text) continue;
    out.push({ start, end, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

function parseSrtEvents(t: string): CaptionEvent[] {
  return parseCueBlocks(t);
}

function parseVttEvents(t: string): CaptionEvent[] {
  // Drop the header + NOTE/STYLE blocks; cue parsing is shared with SRT.
  const body = t
    .split(/\r?\n\r?\n/)
    .filter((b) => !/^(WEBVTT|NOTE|STYLE|REGION)/.test(b.trim()))
    .join("\n\n");
  return parseCueBlocks(body);
}
