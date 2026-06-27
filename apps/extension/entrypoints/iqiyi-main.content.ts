// MAIN-world content script for iQIYI international (iq.com) watch pages.
//
// HOW iQIYI EXPOSES SUBTITLES (from a 2026-06-27 HAR capture):
// iq.com is a Next.js app that SERVER-SIDE-RENDERS the full playback
// descriptor into the page's <script id="__NEXT_DATA__">.  The subtitle
// tracks live at
//   props.initialProps.pageProps.prePlayerData.dash.data.program.stl[]
// Each stl entry carries `_name`, `lid` (iQIYI language id), and relative
// `webvtt` / `srt` / `xml` (TTML) paths resolved against meta.video.iqiyi.com.
// There is NO client-side /dash request and the API calls that DO happen are
// JSONP — so fetch/XHR/JSONP hooks all see nothing.  We read __NEXT_DATA__
// from the DOM instead.  We ALSO sniff fetch/XHR JSON bodies for the same
// `program.stl` shape, to catch whatever an in-app (SPA) episode change uses
// (none observed in the capture, kept as belt-and-braces).
//
// Subtitle files are unauthenticated GETs from meta.video.iqiyi.com (the
// stl paths already carry the qd_uid/qd_tm/qd_tvid/qyid/lid query the CDN
// wants), fetched cross-origin by the ISO world (host_permissions covers
// *.iqiyi.com).  We prefer the `webvtt` field → Loom's existing parseVtt; no
// new parser.
//
// Mirrors netflix-main's ROLE — emit the same
// { source: "loom-main", type: "tracklist", … } message discover.ts consumes.
// Bidirectional postMessage keeps MAIN dependency-free (no browser.*).

import { ISO_SOURCE, MAIN_SOURCE, logDev } from "@/lib/env";

interface CaptionTrackSerialized {
  id: string;
  languageCode: string;
  name: string;
  baseUrl: string;
  kind: "manual" | "asr";
  isCc: boolean;
  audioLangCode?: string;
}

interface PostPayload {
  videoId: string | null;
  status: "ok" | "no-captions";
  tracks: CaptionTrackSerialized[];
}

interface LoomIqMainHolder {
  ingest: (root: unknown, label: string) => void;
  handleRequestTracklist: () => void;
}

interface IqSubtitle {
  _name?: string;
  name?: string;
  lid?: number | string;
  webvtt?: string;
  srt?: string;
  xml?: string;
}
interface IqAudio {
  lid?: number | string;
  _selected?: boolean;
}
interface IqProgram {
  stl?: IqSubtitle[];
  audio?: IqAudio[];
}

// iQIYI (iq.com) language id → Loom BCP-47 code.  Confirmed against a live
// __NEXT_DATA__ capture (2026-06-27).  Unknown ids fall back to the track's
// own `_name` label and are logged so the map can be extended.
const LID_MAP: Record<string, string> = {
  "1": "zh-Hans", // Simplified Chinese — the headline same-language case
  "2": "zh-Hant", // Traditional Chinese
  "3": "en",
  "4": "ko",
  "5": "ja",
  "6": "fr",
  "18": "th",
  "21": "ms",
  "23": "vi",
  "24": "id",
  "26": "es",
  "28": "ar",
};

// Base for the relative stl paths.  (The capture had no `dstl`; the player
// fetched the same paths from this CDN host.)
const SUB_BASE = "https://meta.video.iqiyi.com";

export default defineContentScript({
  // ALL of iq.com (no-refresh fix): iq.com is a Next.js SPA.  We read
  // __NEXT_DATA__ on each document load and sniff fetch/XHR for in-app nav.
  matches: ["*://*.iq.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    logDev("[Loom IQ MAIN] script loaded");

    let latestPayload: object | null = null;
    let reemittedForCurrentPayload = false;
    // Dedupe: __NEXT_DATA__ + a fetch-sniff can surface the same tracklist;
    // only post when the (video + track-id) signature actually changes.
    let lastKey: string | null = null;

    // Reload-safe install (Firefox re-injects MAIN on extension reload; the
    // fetch/XHR wrappers patch the PAGE globals, which a reload does NOT
    // unwrap).  Install hooks ONCE through a mutable holder; on re-injection
    // swap in fresh handlers and re-read __NEXT_DATA__ so the newest code wins.
    const HOLDER_KEY = "__loomIqMainHolder_" + MAIN_SOURCE;
    const w = window as unknown as Record<string, LoomIqMainHolder | undefined>;
    const existing = w[HOLDER_KEY];
    if (existing) {
      existing.ingest = ingest;
      existing.handleRequestTracklist = handleRequestTracklist;
      logDev("[Loom IQ MAIN] re-attached after reload");
      readNextData(existing.ingest);
      return;
    }
    const holder: LoomIqMainHolder = { ingest, handleRequestTracklist };
    w[HOLDER_KEY] = holder;

    installFetchHook((root, label) => holder.ingest(root, label));
    installXhrHook((root, label) => holder.ingest(root, label));
    readNextData((root, label) => holder.ingest(root, label));

    /** Build a tracklist from any object that contains a `program.stl` and
        post it (deduped). */
    function ingest(root: unknown, label: string): void {
      const program = findProgram(root);
      if (!program) return;
      const stl = Array.isArray(program.stl) ? program.stl : [];

      const tracks: CaptionTrackSerialized[] = [];
      for (let i = 0; i < stl.length; i++) {
        const s = stl[i];
        const path = s.webvtt; // prefer WebVTT (parsed natively)
        if (!path) {
          logDev("[Loom IQ MAIN] stl entry has no webvtt:", s._name ?? s.lid);
          continue;
        }
        const baseUrl = resolveSubUrl(path);
        if (!baseUrl) continue;
        const lidKey = s.lid != null ? String(s.lid) : "";
        const languageCode = LID_MAP[lidKey] ?? "";
        if (!languageCode) {
          logDev("[Loom IQ MAIN] unknown lid", lidKey, "name =", s._name ?? s.name);
        }
        tracks.push({
          id: `iq-${lidKey || i}`,
          languageCode,
          name: s._name || s.name || languageCode || `track ${i}`,
          baseUrl,
          kind: "manual",
          isCc: false,
        });
      }

      const audioLang = audioLangOf(program);
      if (audioLang) for (const t of tracks) t.audioLangCode = audioLang;

      const videoId = tvidOf(stl) ?? readVideoId();
      const key = videoId + "|" + tracks.map((t) => t.id).join(",");
      if (tracks.length === 0) {
        logDev("[Loom IQ MAIN] program found but 0 webvtt tracks (", label, ")");
      }
      if (key === lastKey) return; // already posted this exact tracklist
      lastKey = key;

      logDev(
        "[Loom IQ MAIN] tracklist via",
        label,
        "— tracks =",
        tracks.length,
        "videoId =",
        videoId ?? "(none)",
        "audioLang =",
        audioLang ?? "(none)",
        "langs =",
        tracks.map((t) => t.languageCode || "?").join(","),
      );
      postPayload({
        videoId,
        status: tracks.length > 0 ? "ok" : "no-captions",
        tracks,
      });
    }

    /** Read the SSR'd __NEXT_DATA__ blob (now or once the DOM has it). */
    function readNextData(cb: (root: unknown, label: string) => void): void {
      const tryRead = (): boolean => {
        const el = document.getElementById("__NEXT_DATA__");
        const text = el?.textContent;
        if (!text) return false;
        try {
          cb(JSON.parse(text), "__NEXT_DATA__");
        } catch (e) {
          logDev("[Loom IQ MAIN] __NEXT_DATA__ parse failed:", e);
        }
        return true;
      };
      if (tryRead()) return;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => tryRead(), {
          once: true,
        });
      } else {
        window.addEventListener("load", () => tryRead(), { once: true });
      }
    }

    function postPayload(payload: PostPayload): void {
      const fullPayload = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = fullPayload;
      reemittedForCurrentPayload = false;
      window.postMessage(fullPayload, location.origin);
      logDev("[Loom IQ MAIN] tracklist posted:", payload.status);
    }

    function handleRequestTracklist(): void {
      if (latestPayload && !reemittedForCurrentPayload) {
        logDev("[Loom IQ MAIN] ISO requested tracklist re-emit");
        reemittedForCurrentPayload = true;
        window.postMessage(latestPayload, location.origin);
      }
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as { source?: string; type?: string } | undefined;
      if (!data || data.source !== ISO_SOURCE) return;
      if (data.type === "request-tracklist") {
        holder.handleRequestTracklist();
      }
    });

    /** Sniff fetch JSON for the program.stl shape (SPA episode change). */
    function installFetchHook(cb: (root: unknown, label: string) => void): void {
      const origFetch = window.fetch;
      window.fetch = function (
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const url = urlOf(input);
        const promise = origFetch.call(this, input, init);
        if (url && /iq\.com/.test(url)) {
          promise
            .then((resp) => {
              const ct = resp.headers.get("content-type") || "";
              if (!/json/i.test(ct)) return;
              resp
                .clone()
                .text()
                .then((text) => {
                  if (!looksLikeProgram(text)) return;
                  try {
                    cb(JSON.parse(text), "fetch");
                  } catch {
                    /* ignore */
                  }
                })
                .catch(() => {});
            })
            .catch(() => {});
        }
        return promise;
      } as typeof window.fetch;
    }

    /** Sniff XHR JSON for the program.stl shape (SPA episode change). */
    function installXhrHook(cb: (root: unknown, label: string) => void): void {
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
        if (url && /iq\.com/.test(url)) {
          this.addEventListener("load", () => {
            try {
              const text = this.responseText;
              if (looksLikeProgram(text)) cb(JSON.parse(text), "xhr");
            } catch {
              /* ignore */
            }
          });
        }
        return (origSend as (...a: unknown[]) => void).call(this, ...args);
      } as typeof XHR.send;
    }
  },
});

/** Cheap pre-parse gate: does this body look like a playback descriptor? */
function looksLikeProgram(text: string): boolean {
  return (
    typeof text === "string" &&
    text.length < 5_000_000 &&
    text.includes('"stl"') &&
    text.includes('"program"')
  );
}

/** Recursively find the first object holding an `stl` array (the program). */
function findProgram(root: unknown, depth = 0): IqProgram | null {
  if (!root || typeof root !== "object" || depth > 14) return null;
  const o = root as Record<string, unknown>;
  if (Array.isArray(o.stl)) return o as IqProgram;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === "object") {
      const found = findProgram(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve an stl path against the subtitle CDN. */
function resolveSubUrl(path: string): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (/^\/\//.test(path)) return "https:" + path;
  return SUB_BASE + (path.startsWith("/") ? path : "/" + path);
}

/** Original audio language → BCP-47, from the selected (or first) audio. */
function audioLangOf(program: IqProgram): string | undefined {
  const audio = Array.isArray(program.audio) ? program.audio : [];
  const sel = audio.find((a) => a && a._selected) ?? audio[0];
  const lid = sel?.lid != null ? String(sel.lid) : "";
  return LID_MAP[lid];
}

/** Stable per-video id: the qd_tvid carried in any stl path's query. */
function tvidOf(stl: IqSubtitle[]): string | null {
  for (const s of stl) {
    const u = s.webvtt || s.srt || s.xml;
    const m = u?.match(/[?&]qd_tvid=(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/** iQIYI watch URL → id segment (fallback when no tvid in paths). */
function readVideoId(): string | null {
  const m = location.pathname.match(/\/play\/([^/?#]+)/);
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
