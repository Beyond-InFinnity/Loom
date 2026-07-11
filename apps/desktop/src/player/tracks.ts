// Local-file caption acquisition for the Loom Player (7c) — the
// "local-file CaptionPlatform" from MOBILE_ROADMAP.md §3 seam #4, built
// entirely on EXISTING sidecar routes (no server changes):
//
//   POST /files/by-path   → file_id for the on-disk .mkv (no byte copy)
//   POST /video/scan      → metadata + subtitle tracks (text tracks come
//                           back already extracted + registered) + audio
//   GET  /files/{id}      → the extracted .ass/.srt text
//
// Parsing to CaptionEvent[] is the package's events-only parser; language
// auto-pick is the package's pickTarget/pickNative over CaptionTrack
// mappings of the scan result.

import { parseSubtitleEvents } from "@loom/player-ui/subs/parse-events";
import type {
  CaptionEvent,
  CaptionTrack,
} from "@loom/player-ui/captions/types";
import {
  API_BASE,
  registerFileByPath,
  scanVideo,
  type ScanResponse,
  type TrackInfo,
  type VideoMetadata,
} from "../api";

export interface PlayerTrack {
  info: TrackInfo;
  caption: CaptionTrack;
}

export interface LoadedMedia {
  fileId: string;
  path: string;
  metadata: VideoMetadata;
  tracks: PlayerTrack[];
  audioLangCode: string | null;
}

export function fileUrl(fileId: string): string {
  return `${API_BASE}/files/${fileId}`;
}

function toCaptionTrack(
  info: TrackInfo,
  audioLangCode: string | null,
): CaptionTrack {
  return {
    id: String(info.id),
    languageCode: info.lang_code ?? info.metadata_lang ?? "und",
    name: info.label,
    baseUrl: info.file_id ? fileUrl(info.file_id) : "",
    kind: "manual",
    // Embedded MKV tracks don't mark SDH structurally; a title hint is the
    // best signal available.
    isCc: /\b(sdh|cc|closed)\b/i.test(info.track_title ?? ""),
    audioLangCode: audioLangCode ?? undefined,
  };
}

/** Register + scan a local media path.  Only selectable text tracks (the
    scan pre-extracts them) become PlayerTracks — image tracks (PGS) are
    the OCR case and out of the player MVP's scope. */
export async function loadMedia(path: string): Promise<LoadedMedia> {
  const slot = await registerFileByPath(path);
  const scan: ScanResponse = await scanVideo(slot.id);
  const audioLangCode =
    scan.audio_tracks.find((a) => a.lang_code)?.lang_code ?? null;
  const tracks = scan.tracks
    .filter((t) => t.selectable && t.file_id)
    .map((info) => ({
      info,
      caption: toCaptionTrack(info, audioLangCode),
    }));
  return {
    fileId: slot.id,
    path,
    metadata: scan.metadata,
    tracks,
    audioLangCode,
  };
}

/** Download + parse one extracted track. */
export async function fetchTrackEvents(
  track: PlayerTrack,
): Promise<CaptionEvent[]> {
  const res = await fetch(fileUrl(track.info.file_id!));
  if (!res.ok) {
    throw new Error(`track download → HTTP ${res.status}`);
  }
  return parseSubtitleEvents(await res.text());
}
