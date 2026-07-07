// MAIN-world content script for Amazon Prime Video pages.
//
// Prime's subtitle track list arrives in the PLAIN-JSON response of
//   POST atv-ps.primevideo.com/playback/prs/GetVodPlaybackResources
// (recon 2026-07-07 — NOT encrypted like Netflix's MSL manifest).  The
// response enumerates each subtitle track with a whole-file TTML2 URL on
// an unauthenticated, ACAO:* CDN (cf-timedtext.aux.pv-cdn.net).  MV3
// webRequest can see the request URL but not its body, and the URLs live
// in the body — so, like Netflix, the only way in is a MAIN-world hook:
// here we wrap `fetch` + `XMLHttpRequest` (Prime uses both across builds)
// and read the GetVodPlaybackResources response.  We OBSERVE the player's
// own request — never forge one (it needs a device/token envelope).
//
// This mirrors netflix-main.content.ts's ROLE — emit the same
// { source: MAIN_SOURCE, type: "tracklist", … } message discover.ts
// already consumes — but the mechanism is a response hook, not JSON.parse.
//
// ⚠️ FIELD NAMES ARE DEFENSIVE.  The GetVod response body was stripped
// from every recon HAR, so the exact key for the subtitle array
// (`subtitleUrls` per the research / greasyfork userscript) and per-entry
// fields are shape-SEARCHED, not hard-coded, and the raw structure is
// logged in dev so the first live session confirms/corrects them.  Once
// verified, this comment + the fallbacks can tighten.
//
// GetVod fires at PAGE LOAD (not on play-press), so the hook installs at
// document_start and caches the latest tracklist; a late-activating
// overlay re-requests it via `request-tracklist`.  Reload-safe install
// (holder sentinel) mirrors the Netflix hook — Firefox re-injects MAIN on
// every extension reload, and re-wrapping fetch/XHR would stack wrappers.

import { ISO_SOURCE, MAIN_SOURCE, logDev } from "@/lib/env";

const GETVOD_MARKER = "GetVodPlaybackResources";
// Legacy endpoint name, still seen in some regions/builds.
const GETVOD_LEGACY = "GetPlaybackResources";

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

interface LoomPrimeHolder {
  handleResponseText: (url: string, text: string) => void;
  handleRequestTracklist: () => void;
}

function isGetVod(url: string): boolean {
  return url.includes(GETVOD_MARKER) || url.includes(GETVOD_LEGACY);
}

export default defineContentScript({
  // All of primevideo.com — the player is embedded on the detail page
  // (no dedicated /watch URL), and Prime is an SPA, so scope site-wide and
  // install the hooks at document_start before the player's GetVod fetch.
  // The hooks no-op unless a GetVod response is seen.
  matches: ["*://*.primevideo.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    logDev("[Loom PRIME MAIN] script loaded");

    let latestPayload: object | null = null;
    let reemitted = false;

    // Reload-safe install (see Netflix hook header): install fetch/XHR
    // wrappers EXACTLY ONCE, route through a mutable holder so a re-injected
    // script swaps in fresh handlers instead of stacking wrappers.
    const HOLDER_KEY = "__loomPrimeMainHolder_" + MAIN_SOURCE;
    const w = window as unknown as Record<string, LoomPrimeHolder | undefined>;
    const existing = w[HOLDER_KEY];
    if (existing) {
      existing.handleResponseText = handleResponseText;
      existing.handleRequestTracklist = handleRequestTracklist;
      logDev("[Loom PRIME MAIN] re-attached after reload (hooks not re-wrapped)");
      return;
    }
    const holder: LoomPrimeHolder = {
      handleResponseText,
      handleRequestTracklist,
    };
    w[HOLDER_KEY] = holder;

    installFetchHook((url, text) => holder.handleResponseText(url, text));
    installXhrHook((url, text) => holder.handleResponseText(url, text));

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as { source?: string; type?: string } | undefined;
      if (!data || data.source !== ISO_SOURCE) return;
      if (data.type === "request-tracklist") holder.handleRequestTracklist();
    });

    /** A GetVod response arrived (from fetch or XHR).  Parse defensively. */
    function handleResponseText(url: string, text: string): void {
      if (!isGetVod(url) || !text) return;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      const rawTracks = findSubtitleEntries(json);
      logDev(
        "[Loom PRIME MAIN] GetVod response — subtitle entries found:",
        rawTracks.length,
        "| top-level keys:",
        json && typeof json === "object"
          ? Object.keys(json as object).join(",")
          : typeof json,
      );
      if (rawTracks.length === 0) {
        // Log a shallow shape sketch so the first live session reveals the
        // real key for the subtitle array if our shape-search missed it.
        logDev("[Loom PRIME MAIN] no subtitle array matched; shape:", sketch(json));
        return;
      }
      // First entry raw, so field names are confirmable in dev.
      logDev("[Loom PRIME MAIN] first subtitle entry:", JSON.stringify(rawTracks[0]).slice(0, 400));

      const audioLang = findAudioLang(json);
      // Diagnostic: dump audio-language-bearing structure so the real field
      // can be wired (auto-pick needs the spoken language to default Top).
      logDev("[Loom PRIME MAIN] audioLang resolved:", audioLang ?? "(none)");
      logDev("[Loom PRIME MAIN] audio-ish paths:", dumpAudioPaths(json));
      const tracks = rawTracks
        .map((e, i) => serializeTrack(e, i, audioLang))
        .filter((t): t is CaptionTrackSerialized => t !== null);

      const videoId = findTitleId(json) ?? readTitleIdFromUrl();
      const status: "ok" | "no-captions" = tracks.length > 0 ? "ok" : "no-captions";
      postPayload({ videoId, status, tracks });
    }

    function postPayload(payload: PostPayload): void {
      const full = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = full;
      reemitted = false;
      window.postMessage(full, location.origin);
      logDev("[Loom PRIME MAIN] tracklist posted:", payload.status, "tracks:", payload.tracks.length);
    }

    function handleRequestTracklist(): void {
      if (latestPayload && !reemitted) {
        reemitted = true;
        window.postMessage(latestPayload, location.origin);
        logDev("[Loom PRIME MAIN] ISO requested tracklist re-emit");
      }
    }
  },
});

/** Wrap window.fetch to observe GetVod responses.  Clones the response so
    the page still consumes its body normally. */
function installFetchHook(onText: (url: string, text: string) => void): void {
  const orig = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await orig.apply(this, args as never);
    try {
      const url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] instanceof Request
            ? args[0].url
            : String((args[0] as URL) ?? "");
      if (isGetVod(url)) {
        res
          .clone()
          .text()
          .then((t) => onText(url, t))
          .catch(() => {});
      }
    } catch {
      /* never break the page's fetch */
    }
    return res;
  } as typeof fetch;
}

/** Wrap XMLHttpRequest to observe GetVod responses (Prime uses XHR for
    some playback calls).  Captures the URL at open(), reads text at load. */
function installXhrHook(onText: (url: string, text: string) => void): void {
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
    try {
      (this as XMLHttpRequest & { __loomUrl?: string }).__loomUrl = String(url);
    } catch {
      /* ignore */
    }
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const url = (this as XMLHttpRequest & { __loomUrl?: string }).__loomUrl ?? "";
      if (isGetVod(url)) {
        this.addEventListener("load", () => {
          try {
            const type = this.responseType;
            if (type === "" || type === "text") onText(url, this.responseText);
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* never break the page's send */
    }
    return (origSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof XHR.send;
}

/** Shape-search the parsed GetVod JSON for the subtitle-track array.
    Defensive: matches an array whose entries look like subtitle
    descriptors (a URL-ish field + a language-ish field), found under any
    key at shallow depth.  Prefers a key literally named subtitle*. */
function findSubtitleEntries(json: unknown): Array<Record<string, unknown>> {
  const looksLikeSub = (o: unknown): o is Record<string, unknown> => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    const hasUrl = Object.keys(r).some(
      (k) => /url/i.test(k) && typeof r[k] === "string",
    );
    const hasLang = Object.keys(r).some(
      (k) => /lang|locale/i.test(k) && typeof r[k] === "string",
    );
    return hasUrl && hasLang;
  };
  const isSubArray = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) && v.length > 0 && v.every(looksLikeSub);

  // Preferred: a key named like subtitleUrls / subtitles.
  const preferred: Array<Record<string, unknown>> = [];
  const other: Array<Record<string, unknown>> = [];
  const walk = (obj: unknown, keyName: string, depth: number): void => {
    if (!obj || typeof obj !== "object" || depth > 6) return;
    if (isSubArray(obj)) {
      if (/subtitle/i.test(keyName)) preferred.push(...(obj as Array<Record<string, unknown>>));
      else other.push(...(obj as Array<Record<string, unknown>>));
      return;
    }
    if (Array.isArray(obj)) {
      for (const v of obj) walk(v, keyName, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Skip forced-narrative arrays — not learner subtitle tracks.
      if (/forced/i.test(k)) continue;
      walk(v, k, depth + 1);
    }
  };
  walk(json, "", 0);
  return preferred.length > 0 ? preferred : other;
}

/** Best-effort audio language from the GetVod JSON (for auto-pick's
    default Top layer).  Shape-searched with several patterns; undefined
    when not found → the consumer falls back to tier ordering. */
function findAudioLang(json: unknown): string | undefined {
  let found: string | undefined;
  const walk = (obj: unknown, depth: number): void => {
    if (found || !obj || typeof obj !== "object" || depth > 8) return;
    const r = obj as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) {
      if (found) return;
      // (1) a single audio-language field: audioLanguage / audioLocale /
      //     defaultAudioLanguage / spokenLanguage / originalLanguage.
      if (
        typeof v === "string" &&
        v.length > 0 &&
        (/(audio|spoken|original|default).*(lang|locale)/i.test(k) ||
          /(lang|locale).*(audio|spoken|original)/i.test(k))
      ) {
        found = v;
        return;
      }
      // (2) an array of audio-track objects (has language + an audio-ish
      //     marker: codec / bitrate / channels), whose first / default
      //     entry gives the spoken language.
      if (Array.isArray(v) && /audio/i.test(k)) {
        const track = v.find(
          (t) =>
            t &&
            typeof t === "object" &&
            Object.keys(t as object).some((kk) => /lang|locale/i.test(kk)),
        ) as Record<string, unknown> | undefined;
        if (track) {
          for (const [kk, vv] of Object.entries(track)) {
            if (/lang|locale/i.test(kk) && typeof vv === "string" && vv) {
              found = vv;
              return;
            }
          }
        }
      }
      walk(v, depth + 1);
    }
  };
  walk(json, 0);
  return found;
}

/** Diagnostic (dev): compact list of paths whose key mentions "audio",
    with a short value sketch, so the real audio-language field is
    identifiable from one live session. */
function dumpAudioPaths(json: unknown): string {
  const hits: string[] = [];
  const walk = (obj: unknown, path: string, depth: number): void => {
    if (!obj || typeof obj !== "object" || depth > 8 || hits.length > 30) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (/audio/i.test(k)) {
        const val =
          typeof v === "string"
            ? `"${v.slice(0, 40)}"`
            : Array.isArray(v)
              ? `[${v.length}]`
              : v && typeof v === "object"
                ? `{${Object.keys(v as object).slice(0, 8).join(",")}}`
                : String(v);
        hits.push(`${p}=${val}`);
      }
      walk(v, p, depth + 1);
    }
  };
  walk(json, "", 0);
  return hits.length ? hits.join(" | ") : "(no audio-keyed paths)";
}

/** Best-effort title id (GTI/ASIN) from the GetVod JSON. */
function findTitleId(json: unknown): string | null {
  let found: string | null = null;
  const walk = (obj: unknown, depth: number): void => {
    if (found || !obj || typeof obj !== "object" || depth > 5) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (found) return;
      if (/(titleId|catalogId|asin|gti)/i.test(k) && typeof v === "string") {
        found = v as string;
        return;
      }
      walk(v, depth + 1);
    }
  };
  walk(json, 0);
  return found;
}

/** Fallback title id from the detail-page URL, e.g.
    /region/na/detail/<ID> or a `?gti=`/`?asin=` param. */
function readTitleIdFromUrl(): string | null {
  const m = location.pathname.match(/\/detail\/([A-Z0-9]+)/i);
  if (m) return m[1];
  const params = new URLSearchParams(location.search);
  return params.get("gti") || params.get("asin") || null;
}

// Real GetVod subtitle-entry shape (confirmed live 2026-07-07):
//   { displayName:"Dansk", format:"TTMLv2", languageCode:"da-dk",
//     subtype:"Dialog", trackGroupId:"…", type:"Subtitle", url:"…ttml2" }
// The downstream parseBcp47 resolves region-suffixed codes (ja-jp→ja,
// zh-cn→Hans) by shape, so codes pass through unchanged.

/** One subtitle entry → the shared CaptionTrack wire shape.  Reads the
    known fields (with defensive fallbacks), drops forced narratives, and
    flags SDH/CC by subtype. */
function serializeTrack(
  entry: Record<string, unknown>,
  index: number,
  audioLang: string | undefined,
): CaptionTrackSerialized | null {
  const strField = (re: RegExp): string | undefined => {
    for (const [k, v] of Object.entries(entry)) {
      if (re.test(k) && typeof v === "string" && v.length > 0) return v as string;
    }
    return undefined;
  };
  const url = strField(/url/i);
  const lang = strField(/languageCode/i) || strField(/lang|locale/i);
  if (!url || !lang) return null;
  const subtype = (strField(/subtype/i) || "").toLowerCase();
  const type = (strField(/^type$/i) || "").toLowerCase();
  // Forced narratives (foreign-signage-only) aren't learner dialogue —
  // skip so they don't clutter the picker or get auto-picked.
  if (/forced/.test(subtype) || /forced/.test(type)) return null;
  const name = strField(/displayName|name|label/i) || lang;
  const isCc =
    /sdh|caption|hard.?of.?hearing/.test(subtype) ||
    /caption/.test(type) ||
    /sdh|\bcc\b/i.test(name);
  return {
    // Per-track-unique id: trackGroupId is SHARED across a language's
    // Dialog/SDH variants (would collide → dual-highlight + duplicate React
    // keys + events-cache clobber, exactly the Netflix id lesson), so
    // compose from lang+subtype+index instead.
    id: `pv-${index}-${normalizeLang(lang)}-${subtype || type || "sub"}`,
    languageCode: normalizeLang(lang),
    name,
    baseUrl: url,
    kind: "manual",
    isCc,
    ...(audioLang ? { audioLangCode: normalizeLang(audioLang) } : {}),
  };
}

/** Prime labels Japanese "jp" and sometimes uses region-suffixed codes;
    normalize the couple we know matter to the pipeline's expectations.
    Kept conservative — only remaps clear mislabels, else passes through. */
function normalizeLang(code: string): string {
  const c = code.trim();
  if (/^jp$/i.test(c)) return "ja";
  return c;
}

/** A shallow, log-safe sketch of an unknown JSON shape (top-level keys +
    array lengths) so the first live session reveals the real structure. */
function sketch(json: unknown, depth = 0): string {
  if (json === null || typeof json !== "object") return typeof json;
  if (Array.isArray(json)) return `[${json.length}]`;
  if (depth > 2) return "{…}";
  return (
    "{" +
    Object.entries(json as Record<string, unknown>)
      .slice(0, 20)
      .map(([k, v]) => `${k}:${sketch(v, depth + 1)}`)
      .join(",") +
    "}"
  );
}
