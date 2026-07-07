// Corpus capture — POST /corpus/capture (CORPUS_WIRING.md §1f).
//
// Sends a track's full ordered, timed event list plus media/track identity
// to the Layer-2 corpus when (and only when) consent resolves true.  This
// is provenance the batch romanize/annotate calls structurally cannot
// carry: those payloads are deduplicated and untimed before they leave the
// browser (ROMANIZATION_CACHE.md Layer 1 vs 2).
//
// Contract with the rest of the extension: OPPORTUNISTIC.  Fire-and-forget,
// every failure swallowed, never a spinner, never an error surface.  The
// server is idempotent (content-hash dedup), so the client-side sent-set
// is merely politeness that saves a round trip on re-activation.
//
// Only AUTHENTIC platform tracks are captured — the call sites skip
// tlang-machine-translated layers; MT output is synthetic, not subtitle
// training data.

import { getApiClient } from "../api-client";
import type { CaptionEvent, CaptionTrack } from "../captions/types";
import { logDev } from "../env";
import { isCaptureEnabled } from "./consent";

// Mirror the server's validation caps (loom_api/routes/corpus.py).  A
// FastAPI list/str max_length violation 422s the WHOLE request, so the
// client must pre-shrink rather than trust the server to trim.
const MAX_LINES = 10000;
const MAX_TEXT_LENGTH = 5000;

export interface CaptureContext {
  platform: string;
  /** Platform media id (YT videoId / NF movieId).  Null/empty → the page
      pathname stands in (iQIYI/WeTV don't extract an id yet). */
  videoId: string | null;
  /** Raw document.title — cleaned here; best-effort, server COALESCEs. */
  title?: string | null;
  /** location.pathname, for the media-id fallback. */
  pathname: string;
  /** Platform-specific DOM reader for the real media title
      (CaptionPlatform.readMediaTitle) — used where document.title is NOT
      the video name (Netflix's tab title is literally "Netflix").  May
      return null transiently (Netflix mounts [data-uia="video-title"]
      only while the controls chrome is up), so captureTracks polls it
      briefly before falling back to `title`. */
  readTitle?: () => string | null;
}

export interface CaptureLineBody {
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface CapturePayload {
  opt_in_training: true;
  platform: string;
  media_id: string;
  title: string | null;
  origin_lang: string | null;
  track_id: string;
  track_lang: string;
  is_cc: boolean;
  track_kind: string | null;
  lines: CaptureLineBody[];
}

/** A cleaned title that is JUST the platform name carries zero
    information (Netflix's document.title is literally "Netflix") — and
    it's actively harmful: the server keeps the FIRST non-null title per
    media (`COALESCE(existing, new)`), so storing junk blocks a later good
    capture from ever healing the row.  Junk → null keeps it healable. */
const JUNK_TITLE = /^(YouTube|Netflix|iQIYI|iQ\.com|WeTV|Prime Video|Amazon)$/i;

/** Strip the platform suffix noise from document.title.  Best-effort —
    a wrong title is harmless (display metadata only, never identity),
    but a KNOWN-junk title is worse than null (see JUNK_TITLE).  Prime's
    document.title is e.g. "Watch Evangelion … | Prime Video" or bare
    "Prime Video"; strip the suffix + drop a leading "Watch " verb. */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = raw
    .replace(/\s*[-–|]\s*(YouTube|Netflix|iQIYI|iQ\.com|WeTV|Prime Video|Amazon\.[a-z.]+)\s*$/i, "")
    .trim();
  // Prime prefixes watch-page titles with "Watch " — drop it so the corpus
  // title is the bare work name.
  cleaned = cleaned.replace(/^Watch\s+/i, "").trim();
  if (cleaned.length === 0 || JUNK_TITLE.test(cleaned)) return null;
  return cleaned.slice(0, 512);
}

export const TITLE_POLL_ATTEMPTS = 20;
export const TITLE_POLL_INTERVAL_MS = 500;

/** Resolve the best available title: poll the platform's DOM reader (it
    can be transiently null — Netflix's title element exists only while
    the controls chrome is mounted), fall back to the cleaned
    document.title.  Never throws; never returns platform-name junk.
    Capture is fire-and-forget, so the up-to-10s poll delays nothing
    user-visible. */
export async function resolveCaptureTitle(
  ctx: Pick<CaptureContext, "title" | "readTitle">,
  attempts: number = TITLE_POLL_ATTEMPTS,
  intervalMs: number = TITLE_POLL_INTERVAL_MS,
): Promise<string | null> {
  if (ctx.readTitle) {
    for (let i = 0; i < attempts; i++) {
      let read: string | null = null;
      try {
        read = ctx.readTitle();
      } catch {
        break; // broken reader → fall back, don't keep polling it
      }
      const title = cleanTitle(read);
      if (title !== null) return title;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
  return cleanTitle(ctx.title);
}

export function resolveMediaId(
  videoId: string | null,
  pathname: string,
): string {
  const id = (videoId ?? "").trim();
  return (id || pathname || "/").slice(0, 256);
}

/** Pure payload builder — unit-tested.  Preserves each event's original
    index as `seq` so server-side ordering survives the oversized-text
    drop; rounds/clamps times to the server's non-negative-int contract. */
export function buildCapturePayload(
  ctx: CaptureContext,
  track: CaptionTrack,
  events: CaptionEvent[],
): CapturePayload {
  const lines: CaptureLineBody[] = [];
  for (let i = 0; i < events.length && lines.length < MAX_LINES; i++) {
    const ev = events[i];
    if (!ev.text || ev.text.length > MAX_TEXT_LENGTH) continue;
    lines.push({
      seq: i,
      start_ms: Math.max(0, Math.round(ev.start)),
      end_ms: Math.max(0, Math.round(ev.end)),
      text: ev.text,
    });
  }
  return {
    opt_in_training: true,
    platform: ctx.platform,
    media_id: resolveMediaId(ctx.videoId, ctx.pathname),
    title: cleanTitle(ctx.title),
    origin_lang: track.audioLangCode ?? null,
    track_id: track.id,
    track_lang: track.languageCode,
    is_cc: track.isCc ?? false,
    track_kind: track.kind ?? null,
    lines,
  };
}

const sent = new Set<string>();

export function _resetSentForTests(): void {
  sent.clear();
}

/** Session-level politeness dedup key.  The SERVER's identity is the
    content hash; this only avoids obviously-redundant round trips. */
export function sentKey(ctx: CaptureContext, track: CaptionTrack): string {
  return `${ctx.platform}::${resolveMediaId(ctx.videoId, ctx.pathname)}::${track.id}`;
}

export interface CaptureEntry {
  track: CaptionTrack;
  events: CaptionEvent[];
}

/** Fire-and-forget capture of one or more authentic tracks.  Checks
    consent once per call; resolves without throwing, always. */
export async function captureTracks(
  ctx: CaptureContext,
  entries: CaptureEntry[],
): Promise<void> {
  try {
    if (entries.length === 0) return;
    if (!(await isCaptureEnabled())) return;
    // Claim sent-set slots BEFORE the (possibly multi-second) title poll,
    // so a re-entrant call during the poll can't double-send.
    const pending: CaptureEntry[] = [];
    for (const entry of entries) {
      if (!entry.events || entry.events.length === 0) continue;
      const key = sentKey(ctx, entry.track);
      if (sent.has(key)) continue;
      sent.add(key);
      pending.push(entry);
    }
    if (pending.length === 0) return;
    // One title resolution shared by every track of this media.
    const title = await resolveCaptureTitle(ctx);
    for (const { track, events } of pending) {
      const body = buildCapturePayload({ ...ctx, title }, track, events);
      if (body.lines.length === 0) continue;
      void getApiClient()
        .POST("/corpus/capture", { body })
        .then(({ data, error }) => {
          if (error) {
            logDev("[Loom Corpus] capture rejected:", error);
          } else {
            logDev(
              "[Loom Corpus] capture",
              body.platform,
              body.media_id,
              body.track_lang,
              `${body.lines.length} lines →`,
              data?.stored ? "stored" : `no-op (${data?.reason || (data?.deduped ? "deduped" : "?")})`,
            );
          }
        })
        .catch((e) => logDev("[Loom Corpus] capture failed:", e));
    }
  } catch (e) {
    // Capture must never disturb the caption pipeline.
    logDev("[Loom Corpus] capture error (swallowed):", e);
  }
}
