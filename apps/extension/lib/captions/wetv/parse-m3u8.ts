// Minimal HLS (m3u8) playlist → segment-URL list, for WeTV subtitles.
//
// WeTV's getvinfo lists each subtitle track's URL as `…/<file>.vtt.m3u8`
// (an HLS wrapper).  In practice the playlist points at a single full
// WebVTT file (`…/<file>.vtt`), but it can in principle list multiple
// segments.  This pure function extracts the segment URIs from a playlist
// body and resolves them to absolute URLs against the playlist's own URL,
// so the platform adapter can fetch + concatenate them.  Cue stitching
// (parse + merge + sort) happens in the adapter; this stays a pure,
// testable string transform.
//
// We deliberately do NOT implement full HLS — no variant/master playlists,
// no byte-range, no key handling.  Subtitle media playlists are flat lists
// of `#`-comment lines + plain segment URIs, which is all we read.

/** Parse an m3u8 media playlist body → absolute segment URLs.
    Returns [] for anything that isn't a recognizable playlist. */
export function parseM3u8Segments(body: string, baseUrl: string): string[] {
  const text = String(body);
  if (!/^﻿?#EXTM3U/.test(text.trimStart())) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue; // tags/comments
    const abs = resolveAgainst(line, baseUrl);
    if (abs) out.push(abs);
  }
  return out;
}

/** Resolve a (possibly relative) URI against the playlist URL. */
function resolveAgainst(uri: string, baseUrl: string): string | null {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}
