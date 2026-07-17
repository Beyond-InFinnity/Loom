// Netflix caption platform adapter.
//
// Netflix's path is structurally SIMPLER than YouTube's: there is no
// pot-token to capture and no lang-swap.  The MSL-decrypted manifest
// (caught by entrypoints/netflix-main.content.ts's JSON.parse hook)
// enumerates every subtitle track with its own signed, ~12 h-TTL
// WebVTT URL, already on CaptionTrack.baseUrl.  So:
//
//   acquireSession()  — immediate no-op success; handle is null because
//                       no per-session secret is needed.  (discover.ts
//                       still gates on acq.ok before fetching.)
//   fetchTrackEvents()— a direct GET of track.baseUrl + parseVtt().  No
//                       URL rewriting; tlang is ignored (supportsTranslate
//                       is false — Netflix has no MT-on-the-fly).
//
// The FanoutTrackResult diagnostic shape is reused verbatim so
// discover.ts's caching + the "0 events for …" console.warn breadcrumb
// stay platform-agnostic.

import { parseVtt } from "../netflix/parse-vtt";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionTrack } from "../types";
import { logDev } from "../../env";
import {
  NETFLIX_PLAYER_ROOT,
  NETFLIX_VIDEO_SELECTOR,
  hideNetflixCaptions,
  restoreNetflixCaptions,
} from "../../overlay/netflix-player-anchor";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

/** Minimal structural slice of Element used by readNetflixVideoTitle, so
    unit tests (node-env vitest, no DOM) can pass a hand-rolled stub. */
interface TitleNode {
  textContent: string | null;
  querySelector(sel: string): TitleNode | null;
  querySelectorAll(sel: string): Iterable<TitleNode>;
}

/** Read the currently-playing title from the player chrome's
    `[data-uia="video-title"]` block.  Episodic titles render as
    `<h4>Show</h4><span>E5</span><span>Episode name</span>`; films are
    h4-only (or plain text).  The element exists only while the controls
    chrome is mounted — Netflix unmounts it when controls idle out — so
    callers poll rather than treating null as final.  This is the corpus
    capture's title source: document.title on a Netflix watch page is the
    literal string "Netflix" (CORPUS_WIRING.md §7.2). */
export function readNetflixVideoTitle(
  root: Pick<TitleNode, "querySelector">,
): string | null {
  const el = root.querySelector('[data-uia="video-title"]');
  if (!el) return null;
  const show = el.querySelector("h4")?.textContent?.trim() ?? "";
  const detail = Array.from(el.querySelectorAll("span"))
    .map((s) => s.textContent?.trim() ?? "")
    .filter((s) => s.length > 0)
    .join(" ");
  const title = show
    ? detail
      ? `${show} — ${detail}`
      : show
    : (el.textContent?.trim() ?? "");
  return title.length > 0 ? title : null;
}

export const netflixPlatform: CaptionPlatform = {
  id: "netflix",
  supportsTranslate: false,

  // Corpus capture title source (document.title is just "Netflix" here).
  readMediaTitle: () => readNetflixVideoTitle(document),

  // Identity guard for discover's latched-payload replay (SPA nav).
  currentVideoId: () =>
    location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? null,

  // Overlay seam (5h-3).  Selectors + native-caption hiding from the
  // live-capture recon; see lib/overlay/netflix-player-anchor.ts.
  playerRootSelector: NETFLIX_PLAYER_ROOT,
  videoSelector: NETFLIX_VIDEO_SELECTOR,
  hideNativeCaptions: hideNetflixCaptions,
  restoreNativeCaptions: restoreNetflixCaptions,

  acquireSession(): Promise<SessionAcquisition> {
    // Nothing to acquire — each track already carries its own signed
    // WebVTT URL from the manifest.  Ready to fetch immediately.
    return Promise.resolve({ ok: true, handle: null });
  },

  async fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    // baseUrl is the signed WebVTT URL straight off the manifest.  tlang
    // is intentionally ignored (supportsTranslate: false) — there is no
    // Netflix equivalent of YouTube's MT, so a stray tlang override never
    // reaches here from the settings UI (5h-5 hides that control), and we
    // belt-and-braces ignore it if it does.
    const url = track.baseUrl;
    // HARD TIMEOUT (feedback_async_hang_prevention): a WebVTT GET whose
    // response never settles previously hung resolveCaptions' await
    // forever — status stuck "discovering", zero log output (observed
    // live 2026-07-18: ja track START with no DONE/warn while en
    // completed).  Silent infinite waits are a banned bug class: abort
    // with a LABELED reason so the failure surfaces in the existing
    // "[Loom Fetch] 0 events" warn instead of stalling the pipeline.
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`timeout after ${NETFLIX_VTT_TIMEOUT_MS}ms`)),
      NETFLIX_VTT_TIMEOUT_MS,
    );
    const onCallerAbort = () =>
      ctrl.abort(opts.signal?.reason ?? new Error("caller aborted"));
    if (opts.signal?.aborted) onCallerAbort();
    else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    logDev("[Loom NFLX Fetch]", track.languageCode, "GET", safeHost(url));
    try {
      const response = await fetch(url, { signal: ctrl.signal });
      logDev(
        "[Loom NFLX Fetch]",
        track.languageCode,
        "response: status =",
        response.status,
      );
      const status = response.status;
      if (!response.ok) {
        // A signed URL that has aged past its ~12 h TTL surfaces here as
        // a 403/410; the diagnostic carries the status so discover.ts's
        // warn breadcrumb is actionable ("URL expired, re-trigger play").
        return {
          track,
          url,
          status,
          bodyLength: 0,
          events: null,
          firstText: null,
          error: `HTTP ${status}`,
          isTlang: false,
        };
      }
      const text = await response.text();
      logDev(
        "[Loom NFLX Fetch]",
        track.languageCode,
        "body:",
        text.length,
        "chars",
      );
      if (text.length === 0) {
        return {
          track,
          url,
          status,
          bodyLength: 0,
          events: null,
          firstText: null,
          error: "empty response body",
          isTlang: false,
        };
      }
      const events = parseVtt(text);
      logDev(
        "[Loom NFLX Fetch]",
        track.languageCode,
        "parsed:",
        events.length,
        "events",
      );
      return {
        track,
        url,
        status,
        bodyLength: text.length,
        events,
        firstText: events.length > 0 ? events[0].text : null,
        error: null,
        isTlang: false,
      };
    } catch (e) {
      return {
        track,
        url,
        status: null,
        bodyLength: 0,
        events: null,
        firstText: null,
        error: e instanceof Error ? e.message : String(e),
        isTlang: false,
      };
    } finally {
      clearTimeout(timer);
      // {once:true} only fires-and-forgets; on NORMAL completion the
      // listener would linger on a long-lived caller signal.
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  },
};

/** WebVTT GET timeout.  Generous — a full-episode VTT is ~100–300 kB, so
    20 s only fires on a genuinely wedged connection, never a slow one. */
const NETFLIX_VTT_TIMEOUT_MS = 20_000;

/** Host of a URL for logging, without ever throwing on a malformed one. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}
