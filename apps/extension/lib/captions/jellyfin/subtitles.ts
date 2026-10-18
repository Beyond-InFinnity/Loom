import { parseVtt } from "../netflix/parse-vtt";
import type { CaptionEvent } from "../types";
import type { JellyfinPlaybackSnapshot } from "./metadata";
import { createJellyfinPlaybackIdentity, jellyfinSubtitleTrackId } from "./server-scope";

export const JELLYFIN_SUBTITLE_TIMEOUT_MS = 20_000;
const MAX_VTT_CHARACTERS = 8 * 1024 * 1024;

export interface JellyfinSubtitleRequest {
  readonly method: "GET";
  /** Credential-free, constructed server-side route, never a DeliveryUrl. */
  readonly url: string;
}

/** Called with a MAIN-held snapshot, not a snapshot supplied by a page message.
 * This interface intentionally has no API-key/header/token property. The future
 * MAIN-world transport must use the existing authenticated page context. */
export type JellyfinSubtitleTransport = (
  request: JellyfinSubtitleRequest,
  signal: AbortSignal,
) => Promise<{ readonly status: number; readonly body: string }>;

export function buildJellyfinVttRequest(
  snapshot: JellyfinPlaybackSnapshot,
  trackId: string,
): JellyfinSubtitleRequest | null {
  try {
    const stored = snapshot.identity;
    const identity = createJellyfinPlaybackIdentity(stored.serverBaseUrl, stored.itemId, stored.mediaSourceId);
    if (identity.key !== stored.key) return null;
    const track = snapshot.tracks.find((t) => t.id === trackId);
    if (!track || track.id !== jellyfinSubtitleTrackId(identity, track.streamIndex)) return null;
    // Whole-file VTT in the original media timeline. Zero start offset avoids
    // requesting a resumed/relative fragment and subsequently adding it twice.
    const path = `Videos/${identity.itemId}/${identity.mediaSourceId}/Subtitles/${track.streamIndex}/0/Stream.vtt`;
    const url = new URL(path, identity.serverBaseUrl);
    url.searchParams.set("copyTimestamps", "true");
    return Object.freeze({ method: "GET", url: url.href });
  } catch { return null; }
}

export type JellyfinSubtitleRead =
  | { readonly ok: true; readonly events: CaptionEvent[]; readonly status: number }
  | { readonly ok: false; readonly reason: "aborted" | "inactive" | "stale-playback" | "unknown-track" | "burned-in" | "timeout" | "http" | "invalid-vtt" | "network"; readonly status?: number };

export interface JellyfinSubtitleReadOptions {
  readonly signal: AbortSignal;
  readonly isActive: () => boolean;
  readonly currentPlaybackKey: () => string | null;
  readonly currentPlaybackEpoch: () => number | null;
  readonly transport: JellyfinSubtitleTransport;
}

/** Read-only adapter boundary. No retries or caching; late responses cannot
 * publish into another playback session. The deadline settles even if an
 * injected transport ignores AbortSignal. No remote error text is surfaced. */
export async function readJellyfinSubtitle(
  snapshot: JellyfinPlaybackSnapshot,
  trackId: string,
  opts: JellyfinSubtitleReadOptions,
): Promise<JellyfinSubtitleRead> {
  function gate(): JellyfinSubtitleRead | null {
    if (opts.signal.aborted) return { ok: false, reason: "aborted" };
    if (!opts.isActive()) return { ok: false, reason: "inactive" };
    if (opts.currentPlaybackKey() !== snapshot.identity.key || opts.currentPlaybackEpoch() !== snapshot.playbackEpoch) {
      return { ok: false, reason: "stale-playback" };
    }
    return null;
  }
  const blocked = gate();
  if (blocked) return blocked;
  if (snapshot.selectedSubtitleBurnedIn) return { ok: false, reason: "burned-in" };
  const request = buildJellyfinVttRequest(snapshot, trackId);
  if (!request) return { ok: false, reason: "unknown-track" };

  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish(result: JellyfinSubtitleRead): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    }
    function onAbort(): void {
      controller.abort();
      finish({ ok: false, reason: "aborted" });
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.signal.aborted) { onAbort(); return; }
    timer = setTimeout(() => {
      controller.abort();
      finish({ ok: false, reason: "timeout" });
    }, JELLYFIN_SUBTITLE_TIMEOUT_MS);

    void Promise.resolve().then(async () => {
      if (settled) return;
      const beforeDispatch = gate();
      if (beforeDispatch) { finish(beforeDispatch); return; }
      const response = await opts.transport(request, controller.signal);
      if (settled) return;
      const afterResponse = gate();
      if (afterResponse) { finish(afterResponse); return; }
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        finish({ ok: false, reason: "network" });
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        finish({ ok: false, reason: "http", status: response.status });
        return;
      }
      if (typeof response.body !== "string" || response.body.length > MAX_VTT_CHARACTERS || !/^\uFEFF?WEBVTT(?:[ \t][^\r\n]*)?(?:\r\n|\n|\r|$)/.test(response.body)) {
        finish({ ok: false, reason: "invalid-vtt", status: response.status });
        return;
      }
      const events = parseVtt(response.body).filter((e) =>
        Number.isFinite(e.start) && Number.isFinite(e.end) && e.start >= 0 && e.end > e.start,
      );
      finish({ ok: true, events, status: response.status });
    }).catch(() => {
      if (!settled) finish(gate() ?? { ok: false, reason: "network" });
    });
  });
}

/** Compare the original, unshifted VTT cues against this clock. Jellyfin Web
 * adds transcodingOffsetTicks to the HTML player's clock and subtracts a
 * positive subtitle offset from displayed cue timestamps. Moving that latter
 * adjustment to the lookup clock therefore means ADDING subtitleOffsetSeconds.
 * This accepts an actual playback offset, not a guessed resume position (HLS
 * can already have absolute timestamps). Browser wiring is a separate step. */
export function jellyfinCaptionTimeMs(
  videoTimeSeconds: number,
  transcodingOffsetTicks: number,
  subtitleOffsetSeconds: number,
): number | null {
  if (
    !Number.isFinite(videoTimeSeconds) || videoTimeSeconds < 0 ||
    !Number.isSafeInteger(transcodingOffsetTicks) || transcodingOffsetTicks < 0 ||
    !Number.isFinite(subtitleOffsetSeconds)
  ) return null;
  const result = videoTimeSeconds * 1000 + transcodingOffsetTicks / 10_000 + subtitleOffsetSeconds * 1000;
  return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : null;
}