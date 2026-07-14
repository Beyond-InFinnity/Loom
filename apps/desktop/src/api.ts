// HTTP client for the loom_api sidecar.
//
// Tauri-side everything goes through ``http://localhost:8765``. At step 4
// (web) the same module talks to the production base URL — flipped via
// one ``API_BASE`` constant or env var.

export const API_BASE = "http://localhost:8765";

export type FileSlot = {
  id: string;
  name: string;
  size?: number;
  path?: string;
  lang_code?: string;
};

export type HealthInfo = {
  name: string;
  version: string;
};

export type VideoMetadata = {
  title: string | null;
  year: number | null;
  duration_seconds: number;
  width: number;
  height: number;
};

export type TrackInfo = {
  id: number;
  sub_num: number | null;
  label: string;
  file_id: string | null;
  lang_code: string | null;
  source: string;
  selectable: boolean;
  codec: string | null;
  metadata_lang: string | null;
  track_title: string | null;
};

export type AudioTrackInfo = {
  audio_index: number;
  codec: string | null;
  channels: number | null;
  lang_code: string | null;
  title: string | null;
};

export type ScanResponse = {
  metadata: VideoMetadata;
  tracks: TrackInfo[];
  audio_tracks: AudioTrackInfo[];
};

export async function probeHealth(): Promise<HealthInfo> {
  const [healthRes, rootRes] = await Promise.all([
    fetch(`${API_BASE}/health`),
    fetch(`${API_BASE}/`),
  ]);
  if (!healthRes.ok) {
    throw new Error(`/health → HTTP ${healthRes.status}`);
  }
  const health = await healthRes.json();
  if (health.status !== "ok") {
    throw new Error(`/health returned ${JSON.stringify(health)}`);
  }
  const root = await rootRes.json();
  return { name: root.name, version: root.version };
}

// Poll /health until the sidecar answers (or a timeout).  The player window
// auto-opens a file the instant its mpv engine attaches, which can beat the
// uvicorn sidecar's boot — the first /files/by-path fetch then fails with
// WebKit's "Load failed" network error.  Gating loadMedia on this makes the
// first load wait for the sidecar instead of erroring.  Fast (one /health
// round-trip) once the sidecar is already up.
export async function waitForSidecar(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      await probeHealth();
      return;
    } catch (e) {
      lastErr = e;
      if (Date.now() >= deadline) {
        throw new Error(`sidecar not ready after ${timeoutMs}ms: ${String(lastErr)}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// Desktop fast path: register an absolute on-disk path with the sidecar
// without copying bytes. Returns a FileSlot the rest of the app holds onto.
export async function registerFileByPath(path: string): Promise<FileSlot> {
  const res = await fetch(`${API_BASE}/files/by-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/files/by-path → HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return { id: data.id, name: data.filename, size: data.size, path };
}

// Probe a registered video file: returns container metadata + the list of
// subtitle tracks. Text tracks come back already extracted and registered
// (caller can drop the track's file_id into a slot directly). Image tracks
// (PGS, VobSub) carry selectable=false and file_id=null.
export async function scanVideo(fileId: string): Promise<ScanResponse> {
  const res = await fetch(`${API_BASE}/video/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/video/scan → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// ── Preview ───────────────────────────────────────────────────────────

import type { StyleConfig } from "./styles";

export type TimingOffsets = { bottom_ms: number; top_ms: number };
export type Resolution = { width: number; height: number };
export type PreviewMode = "ass" | "pgs";

export type PreviewRequest = {
  native_file_id: string;
  target_file_id: string;
  target_lang_code: string;
  timestamp_seconds: number;
  styles: StyleConfig;
  offsets?: TimingOffsets;
  source_resolution?: Resolution;
  preview_mode?: PreviewMode;
  video_file_id?: string;
};

export type PreviewResponse = {
  html: string;
  native_text: string;
  target_text: string;
  romanized_text: string;
};

export async function renderPreview(req: PreviewRequest): Promise<PreviewResponse> {
  const res = await fetch(`${API_BASE}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/preview → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// HH:MM:SS.00 — matches loom_app._fmt_ts for consistency.
export function formatTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}.00`;
}

// ── Generate + jobs ───────────────────────────────────────────────────

export type GenerateAssRequest = {
  native_file_id: string;
  target_file_id: string;
  target_lang_code: string;
  styles: StyleConfig;
  offsets?: TimingOffsets;
  source_resolution?: Resolution;
  output_resolution?: Resolution;
  include_annotations?: boolean;
  opt_in_training?: boolean;
};

export type GeneratePgsRequest = {
  native_file_id: string;
  target_file_id: string;
  target_lang_code: string;
  styles: StyleConfig;
  offsets?: TimingOffsets;
  source_resolution?: Resolution;
  output_resolution?: Resolution;
  opt_in_training?: boolean;
};

export type GenerateAssResponse = { file_id: string };

export type JobKind = "ass" | "pgs" | "mux";
export type JobState = "pending" | "running" | "completed" | "failed";

export type JobAccepted = {
  id: string;
  kind: JobKind;
};

export type JobStatus = {
  id: string;
  kind: JobKind;
  state: JobState;
  progress: number;
  phase: string | null;
  result_file_id: string | null;
  error: string | null;
};

export async function generateAss(req: GenerateAssRequest): Promise<GenerateAssResponse> {
  const res = await fetch(`${API_BASE}/generate/ass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/generate/ass → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function generatePgs(req: GeneratePgsRequest): Promise<JobAccepted> {
  const res = await fetch(`${API_BASE}/generate/pgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/generate/pgs → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

export type SuggestFilenameRequest = {
  ext: string;
  video_file_id?: string;
  native_lang_code?: string;
  target_lang_code?: string;
  phonetic_system?: string;
  include_annotations?: boolean;
  include_romanization?: boolean;
};

export type SuggestFilenameResponse = { filename: string };

export async function suggestFilename(
  req: SuggestFilenameRequest,
): Promise<SuggestFilenameResponse> {
  const res = await fetch(`${API_BASE}/generate/suggest-filename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/generate/suggest-filename → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function getJob(id: string): Promise<JobStatus> {
  const res = await fetch(`${API_BASE}/jobs/${id}`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/jobs/${id} → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// ── Mux ───────────────────────────────────────────────────────────────

export type MuxRequest = {
  video_file_id: string;
  ass_file_id?: string;
  sup_file_id?: string;
  output_path: string;

  target_lang_code?: string;
  native_lang_code?: string;
  phonetic_system?: string;
  annotation_enabled?: boolean;

  keep_existing_subs?: boolean;
  keep_attachments?: boolean;
  default_audio_index?: number;
};

export async function muxVideo(req: MuxRequest): Promise<JobAccepted> {
  const res = await fetch(`${API_BASE}/mux`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/mux → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// ── Subtitle language detection (for files picked directly) ───────────

export type DetectLanguageResponse = {
  code: string | null;
  name: string | null;
};

export async function detectSubtitleLanguage(
  fileId: string,
): Promise<DetectLanguageResponse> {
  const res = await fetch(`${API_BASE}/subs/detect-language`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/subs/detect-language → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// ── Language metadata (for lang-aware default fonts + annotation) ─────

export type LanguageMetadata = {
  code: string;
  chinese_variant: string | null;
  phonetic_system: string | null;
  has_phonetic_layer: boolean;
  supports_ass_annotation: boolean;
  annotation_default_enabled: boolean;
  annotation_system_name: string;
  annotation_render_mode: string;
  annotation_font_ratio: number;
  romanization_name: string;
  romanization_confidence: string;
  default_font: string;
  rtl: boolean;
};

export async function fetchLanguageConfig(code: string): Promise<LanguageMetadata> {
  const res = await fetch(
    `${API_BASE}/language/config/${encodeURIComponent(code)}`,
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/language/config/${code} → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// ── Align (compute timing offset between two subtitle files) ──────────

export type AlignRequest = {
  reference_file_id: string;
  target_file_id: string;
};

export type AlignResponse = {
  offset_seconds: number;
  warning?: string | null;
};

export async function alignSubtitles(req: AlignRequest): Promise<AlignResponse> {
  const res = await fetch(`${API_BASE}/align`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/align → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// Fetch a stored file by id as a Uint8Array — ready to hand to Tauri's
// fs writeFile.
export async function downloadFileBytes(fileId: string): Promise<Uint8Array> {
  const res = await fetch(`${API_BASE}/files/${fileId}`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/files/${fileId} → HTTP ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// Mirrors loom_app._parse_time_input — flexible time input:
//   "3"        → 3 minutes (180s)
//   "3.5"      → 3.5 minutes (210s)
//   "3:56"     → 3m 56s  (236s)
//   "1:22:33"  → 1h 22m 33s  (4953s)
//   "1:22:3344" → 1h 22m 33.44s
// Returns null on parse failure. Clamps to [0, max].
export function parseTimeInput(text: string, maxSeconds: number): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  const clamp = (n: number) => Math.max(0, Math.min(Math.round(n), maxSeconds));
  try {
    if (parts.length === 1) {
      const mins = Number(parts[0]);
      if (Number.isNaN(mins)) return null;
      return clamp(mins * 60);
    }
    if (parts.length === 2) {
      const m = Number(parts[0]);
      const s = Number(parts[1]);
      if (Number.isNaN(m) || Number.isNaN(s)) return null;
      return clamp(m * 60 + s);
    }
    if (parts.length === 3) {
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const secPart = parts[2];
      let s: number;
      if (secPart.includes(".")) {
        s = Number(secPart);
      } else if (secPart.length > 2) {
        s = Number(`${secPart.slice(0, 2)}.${secPart.slice(2)}`);
      } else {
        s = Number(secPart);
      }
      if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
      return clamp(h * 3600 + m * 60 + s);
    }
    return null;
  } catch {
    return null;
  }
}
