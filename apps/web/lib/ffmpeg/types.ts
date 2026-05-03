// TypeScript mirrors of the Python wire types in loom_core/models.py
// (TrackInfo, AudioTrackInfo, VideoMetadata).  The web app builds these
// itself from ffmpeg.wasm output rather than calling the API for them
// — server bandwidth budget per the Option B architecture.
//
// Field names + semantics deliberately match the Python side so the
// types can be shared with @loom/api-client consumers later if useful.

export type TrackSource = "mkv" | "external" | "internal";

export interface TrackInfo {
  /** ffmpeg stream index — 0-based, matches `Stream #0:N` in stderr */
  id: number;
  /** Subtitle ordinal (0-based among subtitle tracks).  Null for non-subs. */
  sub_num: number | null;
  /** Display label, e.g. "English (subrip)" */
  label: string;
  /** Codec name (subrip, ass, hdmv_pgs_subtitle, ...) */
  codec: string | null;
  /** BCP-47-ish language tag from Stream metadata, e.g. "eng", "jpn" */
  lang_code: string | null;
  /** Where this track came from. Always "mkv" for tracks discovered by probe. */
  source: TrackSource;
  /** False for image-based subtitle tracks (PGS, VobSub) — those need OCR. */
  selectable: boolean;
  /** Verbatim title from track metadata (often the fansub group) */
  track_title: string | null;
}

export interface AudioTrackInfo {
  /** 0-based index AMONG AUDIO STREAMS ONLY (what ffmpeg -disposition:a:N expects). */
  audio_index: number;
  codec: string | null;
  channels: number | null;
  lang_code: string | null;
  title: string | null;
}

export interface VideoMetadata {
  title: string | null;
  year: number | null;
  duration_seconds: number;
  width: number;
  height: number;
}

export interface ProbeResult {
  /** Top-level video info (dimensions, duration, parsed title) */
  metadata: VideoMetadata;
  /** All subtitle + image-based subtitle tracks in stream order */
  subtitle_tracks: TrackInfo[];
  /** Audio tracks for the mux UI's default-audio selector */
  audio_tracks: AudioTrackInfo[];
  /** Raw ffmpeg stderr captured during probe.  Useful for debugging
      and for showing the user what ffmpeg actually saw. */
  raw_stderr: string;
}

export interface FFmpegClientOptions {
  /** Subscribe to ffmpeg's stderr/stdout lines as they arrive */
  onLog?: (line: string) => void;
  /** Subscribe to ffmpeg's progress events (only meaningful for ops
      where input/output durations match — exec, mux). */
  onProgress?: (event: { progress: number; time: number }) => void;
  /** Override the base URL where /ffmpeg-core.js, /ffmpeg-core.wasm,
      and /worker.js are served.  Defaults to `${origin}/ffmpeg`. */
  baseURL?: string;
}

export interface OperationOptions {
  /** Cancel an in-flight operation */
  signal?: AbortSignal;
  /** Override the per-operation timeout (ms).  Operations have sane
      defaults; only pass this when you have a reason. */
  timeoutMs?: number;
}
