// Parse ffprobe -print_format json output into the typed shapes that
// mirror loom_core/models.py.  Mirrors loom_core/video/mkv_handler.py::
// get_video_metadata + scan_and_extract_tracks (parse-only path; no
// extraction here, that's FFmpegClient.extractTrack).

import type {
  AudioTrackInfo,
  ProbeResult,
  TrackInfo,
  VideoMetadata,
} from "./types";

// Image-based subtitle codecs need OCR before they can be used as text.
// The desktop side surfaces them in the UI (selectable=false) for
// display purposes only.
const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "xsub",
]);

interface FfprobeStreamTags {
  language?: string;
  LANGUAGE?: string;
  title?: string;
  TITLE?: string;
  [k: string]: string | undefined;
}

interface FfprobeStream {
  index: number;
  codec_type?: "video" | "audio" | "subtitle" | "attachment" | "data";
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  tags?: FfprobeStreamTags;
}

interface FfprobeFormat {
  duration?: string;
  tags?: {
    title?: string;
    TITLE?: string;
    date?: string;
    DATE?: string;
    year?: string;
    YEAR?: string;
    [k: string]: string | undefined;
  };
}

interface FfprobeRoot {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function pickTag(tags: Record<string, string | undefined> | undefined, ...keys: string[]): string | null {
  if (!tags) return null;
  for (const k of keys) {
    const v = tags[k];
    if (v) return v;
  }
  return null;
}

function buildLabel(stream: FfprobeStream, fallbackIndex: number): string {
  const lang = pickTag(stream.tags, "language", "LANGUAGE");
  const title = pickTag(stream.tags, "title", "TITLE");
  const codec = stream.codec_name ?? "?";
  const parts: string[] = [];
  if (lang) parts.push(lang);
  if (title) parts.push(title);
  if (parts.length === 0) parts.push(`Track ${fallbackIndex}`);
  return `${parts.join(" — ")} (${codec})`;
}

export function parseProbeJSON(jsonText: string, sourceFilename: string): ProbeResult {
  const root: FfprobeRoot = JSON.parse(jsonText);
  const streams = root.streams ?? [];

  // ── VideoMetadata ────────────────────────────────────────
  const fmtTags = root.format?.tags ?? {};
  const durationStr = root.format?.duration;
  const duration_seconds = durationStr ? parseFloat(durationStr) : 0;

  const videoStream = streams.find((s) => s.codec_type === "video");
  const width = videoStream?.width ?? 1920;
  const height = videoStream?.height ?? 1080;

  let title: string | null = pickTag(fmtTags, "title", "TITLE");
  if (!title) {
    // Fall back to filename without extension.
    const dot = sourceFilename.lastIndexOf(".");
    title = dot > 0 ? sourceFilename.slice(0, dot) : sourceFilename;
  }

  let yearStr: string | null = pickTag(fmtTags, "year", "YEAR");
  if (!yearStr) {
    const date = pickTag(fmtTags, "date", "DATE");
    if (date && date.length >= 4) yearStr = date.slice(0, 4);
  }
  const year = yearStr && /^\d{4}$/.test(yearStr) ? parseInt(yearStr, 10) : null;

  const metadata: VideoMetadata = {
    title,
    year,
    duration_seconds,
    width,
    height,
  };

  // ── Subtitle tracks ──────────────────────────────────────
  const subtitleStreams = streams.filter((s) => s.codec_type === "subtitle");
  const subtitle_tracks: TrackInfo[] = subtitleStreams.map((s, subNum) => {
    const codec = s.codec_name ?? null;
    const isImage = codec ? IMAGE_SUBTITLE_CODECS.has(codec) : false;
    return {
      id: s.index,
      sub_num: subNum,
      label: buildLabel(s, s.index),
      codec,
      lang_code: pickTag(s.tags, "language", "LANGUAGE"),
      source: "mkv",
      // Image-based subs aren't directly usable as text — desktop UI
      // marks them non-selectable too.  4c can extract them as raw
      // bytes; OCR is a separate concern (loom_core/video/ocr.py).
      selectable: !isImage,
      track_title: pickTag(s.tags, "title", "TITLE"),
    };
  });

  // ── Audio tracks ─────────────────────────────────────────
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const audio_tracks: AudioTrackInfo[] = audioStreams.map((s, audioIndex) => ({
    audio_index: audioIndex,
    codec: s.codec_name ?? null,
    channels: s.channels ?? null,
    lang_code: pickTag(s.tags, "language", "LANGUAGE"),
    title: pickTag(s.tags, "title", "TITLE"),
  }));

  return {
    metadata,
    subtitle_tracks,
    audio_tracks,
    raw_stderr: "", // populated by the caller from FFmpeg.on("log") capture
  };
}

/** Pick the right output extension for an extracted subtitle track,
    based on the codec name ffprobe reports.  Mirrors the Python
    extension picker in scan_and_extract_tracks. */
export function extensionForSubtitleCodec(codec: string | null | undefined): string {
  switch (codec) {
    case "subrip": return "srt";
    case "ass":
    case "ssa": return "ass";
    case "mov_text": return "ass"; // ffmpeg can convert mov_text → ass
    case "webvtt": return "vtt";
    case "hdmv_pgs_subtitle": return "sup";
    case "dvd_subtitle": return "sub";
    case "dvb_subtitle": return "sub";
    case "xsub": return "sub";
    default: return "sub"; // catch-all; will likely fail to extract cleanly
  }
}
