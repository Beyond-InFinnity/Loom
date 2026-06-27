// MAIN-world content script for Crunchyroll watch pages.
//
// Crunchyroll's player fetches a playback descriptor from a
// `/playback/v*/.../play` endpoint (also seen as a `cr-play-service` host).
// That JSON response enumerates every soft-subtitle track with its own file
// URL + format (ASS or VTT) — exactly what Loom needs.  The response body is
// read via window.fetch().then(r => r.json()), and Response.json() does NOT
// route through window.JSON.parse, so the Netflix-style JSON.parse hook can't
// see it.  Instead we wrap window.fetch (+ XHR as a fallback) and read a
// CLONED response body — never touching the page's own copy.
//
// This mirrors netflix-main.content.ts's ROLE — emit the same
// { source: "loom-main", type: "tracklist", … } message discover.ts already
// consumes — but is SIMPLER than Netflix: Crunchyroll issues a fresh /play
// fetch for every episode (SPA navigation included), so there's no
// prefetch-vs-advance ambiguity to reduce; each /play just (re)posts the
// tracklist.  We cache the latest payload and re-emit on ISO's
// `request-tracklist` so a late-activating overlay still gets it.
//
// Bidirectional postMessage keeps MAIN dependency-free (no browser.*).

import { ISO_SOURCE, MAIN_SOURCE, logDev } from "@/lib/env";

interface CaptionTrackSerialized {
  id: string;
  languageCode: string;
  name: string;
  baseUrl: string;
  kind: "manual" | "asr";
  isCc: boolean;
  /** Base code of the video's original audio language (from the /play
      `audioLocale`); lets ISO's auto-pick default the Top layer to the
      spoken language.  Omitted when absent. */
  audioLangCode?: string;
}

interface PostPayload {
  videoId: string | null;
  status: "ok" | "no-captions";
  tracks: CaptionTrackSerialized[];
}

/** Swappable handlers stashed on `window` so a re-injected MAIN script
    (extension reload) updates the logic instead of re-wrapping fetch/XHR. */
interface LoomCrMainHolder {
  onPlay: (json: unknown, url: string) => void;
  handleRequestTracklist: () => void;
}

// Loose shapes for the /play response — Crunchyroll exposes `subtitles` and
// `captions` either as a locale-keyed object map ({"ja-JP": {...}}) or an
// array; we read both defensively.
interface CrSubtitle {
  url?: string;
  format?: string; // "ass" | "vtt"
  locale?: string;
  language?: string;
}
type CrSubtitleGroup = Record<string, CrSubtitle> | CrSubtitle[] | undefined;
interface CrPlayResponse {
  audioLocale?: string;
  subtitles?: CrSubtitleGroup;
  captions?: CrSubtitleGroup;
}

export default defineContentScript({
  // ALL of crunchyroll.com (no-refresh fix): Crunchyroll is a SPA, so
  // home/browse → /watch and episode → episode are history.pushState with no
  // document reload.  We wrap window.fetch once on the first page; the wrapper
  // persists across SPA navigations and catches every later /play fetch.
  matches: ["*://*.crunchyroll.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    logDev("[Loom CR MAIN] script loaded");

    let latestPayload: object | null = null;
    let reemittedForCurrentPayload = false;

    // Reload-safe install (same rationale as netflix-main): Firefox re-injects
    // this MAIN script on every extension reload, and the fetch/XHR wrappers
    // patch the PAGE's globals — which the add-on reload does NOT unwrap.
    // Re-wrapping each reload stacks wrappers (every /play handled N times).
    // So install the wrappers + message listener EXACTLY ONCE and route them
    // through a mutable holder; each (re)injection just swaps in fresh
    // handlers.  A full page reload is the only thing that clears the wrappers.
    const HOLDER_KEY = "__loomCrMainHolder_" + MAIN_SOURCE;
    const w = window as unknown as Record<string, LoomCrMainHolder | undefined>;
    const existing = w[HOLDER_KEY];
    if (existing) {
      existing.onPlay = onPlay;
      existing.handleRequestTracklist = handleRequestTracklist;
      logDev("[Loom CR MAIN] re-attached after reload (fetch not re-wrapped)");
      return;
    }
    const holder: LoomCrMainHolder = { onPlay, handleRequestTracklist };
    w[HOLDER_KEY] = holder;

    installFetchHook((json, url) => holder.onPlay(json, url));
    installXhrHook((json, url) => holder.onPlay(json, url));

    function onPlay(json: unknown, url: string): void {
      const play = (json ?? {}) as CrPlayResponse;
      const audioLang = play.audioLocale
        ? normalizeLocale(play.audioLocale)
        : undefined;

      const tracks: CaptionTrackSerialized[] = [
        ...normalizeGroup(play.subtitles, false),
        ...normalizeGroup(play.captions, true),
      ]
        .filter((s) => s.url)
        .map((s, i) => ({
          id: `cr-${s.isCc ? "cc" : "sub"}-${s.locale || i}`,
          languageCode: normalizeLocale(s.locale),
          name: s.locale || "subtitles",
          baseUrl: s.url as string,
          kind: "manual" as const,
          isCc: s.isCc,
          ...(audioLang ? { audioLangCode: audioLang } : {}),
        }));

      const videoId = readVideoId() ?? idFromPlayUrl(url);

      logDev(
        "[Loom CR MAIN] /play:",
        "videoId =",
        videoId ?? "(none)",
        "audioLocale =",
        play.audioLocale ?? "(none)",
        "tracks =",
        tracks.length,
        "url =",
        url,
      );

      // Even with zero text tracks we post "no-captions" so the overlay shows
      // its image-only/empty hint rather than silently spinning.
      const status: "ok" | "no-captions" = tracks.length > 0 ? "ok" : "no-captions";
      postPayload({ videoId, status, tracks });
    }

    function postPayload(payload: PostPayload): void {
      const fullPayload = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = fullPayload;
      reemittedForCurrentPayload = false;
      window.postMessage(fullPayload, location.origin);
      logDev("[Loom CR MAIN] tracklist posted:", payload.status);
    }

    /** ISO asks us to re-emit the latest tracklist when it mounted after the
        /play fetch already fired.  Once per payload. */
    function handleRequestTracklist(): void {
      if (latestPayload && !reemittedForCurrentPayload) {
        logDev("[Loom CR MAIN] ISO requested tracklist re-emit");
        reemittedForCurrentPayload = true;
        window.postMessage(latestPayload, location.origin);
      }
    }

    // Listen for messages from ISO.  Crunchyroll re-fetches /play on episode
    // change, so `watch-changed` is informational only (the natural re-fetch
    // re-posts the tracklist); we still accept request-tracklist for late
    // overlay mounts.  Registered once (reload guard returned early above).
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as
        | { source?: string; type?: string }
        | undefined;
      if (!data || data.source !== ISO_SOURCE) return;
      if (data.type === "request-tracklist") {
        holder.handleRequestTracklist();
      }
    });

    /** Wrap window.fetch to read the /play JSON from a CLONED response. */
    function installFetchHook(cb: (json: unknown, url: string) => void): void {
      const origFetch = window.fetch;
      window.fetch = function (
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const url = urlOf(input);
        const promise = origFetch.call(this, input, init);
        if (url && isPlayUrl(url)) {
          promise
            .then((resp) => {
              resp
                .clone()
                .json()
                .then((json) => {
                  try {
                    cb(json, url);
                  } catch {
                    /* never break the page */
                  }
                })
                .catch(() => {
                  /* non-JSON / body already consumed — ignore */
                });
            })
            .catch(() => {
              /* the page's own fetch rejected — not our concern */
            });
        }
        return promise;
      } as typeof window.fetch;
    }

    /** Fallback: some Crunchyroll client builds use XHR for the /play call.
        Capture the URL at open() and read responseText on load. */
    function installXhrHook(cb: (json: unknown, url: string) => void): void {
      const XHR = XMLHttpRequest.prototype;
      const origOpen = XHR.open;
      const origSend = XHR.send;
      XHR.open = function (
        this: XMLHttpRequest & { __loomUrl?: string },
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) {
        this.__loomUrl = typeof url === "string" ? url : String(url);
        return (origOpen as (...a: unknown[]) => void).call(
          this,
          method,
          url,
          ...rest,
        );
      } as typeof XHR.open;
      XHR.send = function (
        this: XMLHttpRequest & { __loomUrl?: string },
        ...args: unknown[]
      ) {
        const url = this.__loomUrl;
        if (url && isPlayUrl(url)) {
          this.addEventListener("load", () => {
            try {
              cb(JSON.parse(this.responseText), url);
            } catch {
              /* non-JSON / cross-origin opaque — ignore */
            }
          });
        }
        return (origSend as (...a: unknown[]) => void).call(this, ...args);
      } as typeof XHR.send;
    }
  },
});

/** Normalise a /play subtitle group (object map OR array) to a flat list. */
function normalizeGroup(
  group: CrSubtitleGroup,
  isCc: boolean,
): Array<{ url?: string; locale?: string; isCc: boolean }> {
  if (!group) return [];
  const entries: CrSubtitle[] = Array.isArray(group)
    ? group
    : Object.entries(group).map(([locale, v]) => ({ locale, ...v }));
  return entries.map((e) => ({
    url: e.url,
    locale: e.locale || e.language,
    isCc,
  }));
}

/** Crunchyroll locale → Loom languageCode.  Strips region for most
    languages; preserves the Hans/Hant split Loom's romanizer needs for
    Chinese. */
function normalizeLocale(loc?: string): string {
  if (!loc) return "";
  if (/^zh/i.test(loc)) {
    return /tw|hk|hant/i.test(loc) ? "zh-Hant" : "zh-Hans";
  }
  return loc.split("-")[0];
}

/** True for the player's playback-descriptor request.  Matches both the
    `/playback/v3/{id}/{device}/{platform}/play` shape and a versioned
    `…/v1/{id}/…/play` service path.  Broad on purpose — every match is
    logged so the regex can be tightened from live captures. */
function isPlayUrl(url: string): boolean {
  return /\/v\d+\/[^?#]*\/play(?:$|[/?#])/.test(url);
}

/** Best-effort content id from a /play URL: the segment after `/vN/`. */
function idFromPlayUrl(url: string): string | null {
  const m = url.match(/\/v\d+\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Crunchyroll watch URL → episode id, e.g. /watch/GRDQPM1ZY/slug → "GRDQPM1ZY". */
function readVideoId(): string | null {
  const m = location.pathname.match(/\/watch\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Extract a URL string from any fetch input form. */
function urlOf(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    return (input as Request).url;
  }
  return null;
}
