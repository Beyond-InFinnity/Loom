// Corpus capture for the web app (CORPUS_WIRING.md multi-surface).
//
// After the generator parses the uploaded subtitle tracks, this sends each
// parsed track — full ordered timed events, ASS style names, and the style
// definitions — to POST /corpus/capture, gated by the visible
// "Contribute caption data" checkbox next to Generate (default ON; a
// first-party surface, disclosed on /privacy).
//
// Like every capture path: fire-and-forget, fail-soft, never affects the
// generation.  The server's content-hash dedup makes regenerating the same
// files a no-op.  File sources capture ALL non-comment events including
// signs/karaoke — stylized text is the hard case Step 6's OCR training
// wants — unlike the extension, which only ever sees plain dialogue text.

import type { LoomClient } from "@loom/api-client";

import { isComment, type SSAFileShape, type SSAStyle, type Color } from "../subs/types";
import { stripAssOverrideTags } from "../subs/generate-ass";

// Mirror the server's 422-able caps (loom_api/routes/corpus.py).
const MAX_LINES = 10000;
const MAX_TEXT_LENGTH = 5000;

export interface FileCaptureContext {
  /** Uploaded file's name — the fansub release name is the best media
      identity a local file has. */
  fileName: string;
  /** Container title from ffprobe metadata, when present. */
  title?: string | null;
  /** "target" | "native" — becomes part of the track id. */
  role: string;
  trackLang: string;
  /** ffmpeg stream index (or any stable per-file track identity). */
  trackId: string | number;
}

function colorHex(c: Color): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${h(c.a)}`;
}

/** SSAStyle map → JSON-safe {name: {attr: string}} for styles_json. */
export function serializeStyles(
  styles: Map<string, SSAStyle>,
): Record<string, Record<string, string>> | null {
  if (styles.size === 0) return null;
  const out: Record<string, Record<string, string>> = {};
  for (const [name, s] of styles) {
    out[name] = {
      fontname: s.fontname,
      fontsize: String(s.fontsize),
      bold: String(s.bold),
      italic: String(s.italic),
      underline: String(s.underline),
      strikeout: String(s.strikeout),
      primarycolor: colorHex(s.primarycolor),
      secondarycolor: colorHex(s.secondarycolor),
      outlinecolor: colorHex(s.outlinecolor),
      backcolor: colorHex(s.backcolor),
      scale_x: String(s.scale_x),
      scale_y: String(s.scale_y),
      spacing: String(s.spacing),
      angle: String(s.angle),
      border_style: String(s.border_style),
      outline: String(s.outline),
      shadow: String(s.shadow),
      alignment: String(s.alignment),
    };
  }
  return out;
}

export interface CaptureLineBody {
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  style: string | null;
}

/** Pure payload builder — mirrors the desktop sidecar's shaping
    (loom_api/corpus_forward.py): comments skipped, override tags
    stripped, original event index preserved as seq. */
export function buildFileCapturePayload(ctx: FileCaptureContext, subs: SSAFileShape) {
  const stem = ctx.fileName.replace(/\.[^.]+$/, "");
  const lines: CaptureLineBody[] = [];
  for (let i = 0; i < subs.events.length && lines.length < MAX_LINES; i++) {
    const ev = subs.events[i];
    if (isComment(ev)) continue;
    const text = stripAssOverrideTags(ev.text).replace(/\\N/gi, " ").trim();
    if (!text || text.length > MAX_TEXT_LENGTH) continue;
    lines.push({
      seq: i,
      start_ms: Math.max(0, Math.round(ev.start)),
      end_ms: Math.max(0, Math.round(ev.end)),
      text,
      style: ev.style || null,
    });
  }
  return {
    opt_in_training: true as const,
    platform: "web",
    media_id: stem.slice(0, 256) || "/",
    title: (ctx.title ?? stem).slice(0, 512) || null,
    origin_lang: null,
    track_id: `${ctx.role}:${ctx.trackId}`.slice(0, 256),
    track_lang: ctx.trackLang,
    is_cc: false,
    track_kind: "file",
    lines,
    styles: serializeStyles(subs.styles),
  };
}

/** Fire-and-forget capture of one parsed track.  Never throws. */
export function captureParsedTrack(
  client: LoomClient,
  ctx: FileCaptureContext,
  subs: SSAFileShape,
): void {
  try {
    const body = buildFileCapturePayload(ctx, subs);
    if (body.lines.length === 0) return;
    void client
      .POST("/corpus/capture", { body })
      .then(({ data, error }) => {
        if (error) console.warn("[Loom] corpus capture rejected:", error);
        else if (!data?.stored && !data?.deduped)
          console.info("[Loom] corpus capture no-op:", data?.reason);
      })
      .catch((e) => console.warn("[Loom] corpus capture failed:", e));
  } catch (e) {
    console.warn("[Loom] corpus capture error (swallowed):", e);
  }
}
