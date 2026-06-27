// MAIN-world content script for WeTV (wetv.vip) play pages.
//
// HOW WeTV EXPOSES SUBTITLES (from a 2026-06-27 HAR capture):
// The player requests `https://play.wetv.vip/getvinfo?…&cKey=<signed>&callback=
// getinfo_callback_<n>` as a JSONP <script> (response is
// `getinfo_callback_<n>({…})`, served as application/javascript).  The
// response lists subtitle tracks at `sfl.fi[]`, each with `lang` (e.g.
// "ZH-CN"), `name`, `captionType`, and a `url` of the form
// `…/<file>.vtt.m3u8` (an HLS wrapper over a single WebVTT file).
//
// Because it's JSONP via <script>, fetch/XHR hooks see nothing — so we watch
// <script> insertions, find the getvinfo script, read its `callback` param,
// and wrap that global callback to capture the parsed JSON when the response
// fires.  (We ALSO keep a fetch/XHR text-sniff that strips the JSONP wrapper,
// as a belt-and-braces fallback for any build that uses XHR.)  The getvinfo
// request is cKey-signed; we OBSERVE the player's own call, never forge it.
//
// Mirrors netflix-main / iqiyi-main's ROLE — emit the same
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

interface LoomWetvMainHolder {
  onVinfo: (json: unknown, url: string) => void;
  handleRequestTracklist: () => void;
}

interface WetvSubtitle {
  lang?: string;
  name?: string;
  captionType?: number;
  url?: string;
}
interface WetvVinfo {
  sfl?: { fi?: WetvSubtitle[] };
}

// WeTV `lang` string → Loom BCP-47 code (confirmed from a live getvinfo).
const LANG_MAP: Record<string, string> = {
  "ZH-CN": "zh-Hans", // Simplified Chinese — the headline same-language case
  "ZH-TW": "zh-Hant",
  EN: "en",
  KO: "ko",
  JA: "ja",
  TH: "th",
  VI: "vi",
  ID: "id",
  MS: "ms",
  AR: "ar",
  PT: "pt",
  ES: "es",
};

export default defineContentScript({
  matches: ["*://*.wetv.vip/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    logDev("[Loom WeTV MAIN] script loaded");

    let latestPayload: object | null = null;
    let reemittedForCurrentPayload = false;
    let lastKey: string | null = null;

    // Reload-safe install (Firefox re-injects MAIN on extension reload; the
    // script/JSONP wrappers patch PAGE globals that a reload doesn't unwrap).
    const HOLDER_KEY = "__loomWetvMainHolder_" + MAIN_SOURCE;
    const w = window as unknown as Record<string, LoomWetvMainHolder | undefined>;
    const existing = w[HOLDER_KEY];
    if (existing) {
      existing.onVinfo = onVinfo;
      existing.handleRequestTracklist = handleRequestTracklist;
      logDev("[Loom WeTV MAIN] re-attached after reload");
      return;
    }
    const holder: LoomWetvMainHolder = { onVinfo, handleRequestTracklist };
    w[HOLDER_KEY] = holder;

    installScriptHook((json, url) => holder.onVinfo(json, url));
    installFetchHook((json, url) => holder.onVinfo(json, url));
    installXhrHook((json, url) => holder.onVinfo(json, url));

    function onVinfo(json: unknown, url: string): void {
      const root = (json ?? {}) as WetvVinfo;
      const fi = root.sfl?.fi;
      if (!Array.isArray(fi)) return;

      const tracks: CaptionTrackSerialized[] = [];
      for (let i = 0; i < fi.length; i++) {
        const s = fi[i];
        if (!s.url) continue;
        const langKey = (s.lang || "").toUpperCase();
        const languageCode = LANG_MAP[langKey] ?? "";
        if (!languageCode) {
          logDev("[Loom WeTV MAIN] unknown lang", s.lang, "name =", s.name);
        }
        tracks.push({
          id: `wetv-${langKey || i}`,
          languageCode,
          name: s.name || languageCode || langKey || `track ${i}`,
          baseUrl: s.url,
          kind: "manual",
          isCc: false,
        });
      }

      const videoId = vidFromUrl(url);
      const key = videoId + "|" + tracks.map((t) => t.id).join(",");
      if (key === lastKey) return;
      lastKey = key;

      logDev(
        "[Loom WeTV MAIN] tracklist — tracks =",
        tracks.length,
        "videoId =",
        videoId ?? "(none)",
        "langs =",
        tracks.map((t) => t.languageCode || "?").join(","),
      );
      postPayload({
        videoId,
        status: tracks.length > 0 ? "ok" : "no-captions",
        tracks,
      });
    }

    function postPayload(payload: PostPayload): void {
      const fullPayload = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = fullPayload;
      reemittedForCurrentPayload = false;
      window.postMessage(fullPayload, location.origin);
      logDev("[Loom WeTV MAIN] tracklist posted:", payload.status);
    }

    function handleRequestTracklist(): void {
      if (latestPayload && !reemittedForCurrentPayload) {
        logDev("[Loom WeTV MAIN] ISO requested tracklist re-emit");
        reemittedForCurrentPayload = true;
        window.postMessage(latestPayload, location.origin);
      }
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as { source?: string; type?: string } | undefined;
      if (!data || data.source !== ISO_SOURCE) return;
      if (data.type === "request-tracklist") holder.handleRequestTracklist();
    });

    /** Primary: getvinfo is JSONP via <script>.  Watch script insertions,
        find the getvinfo script, read its `callback` param, wrap that global
        so we capture the response object when it fires. */
    function installScriptHook(cb: (json: unknown, url: string) => void): void {
      const onScriptSrc = (src: string) => {
        if (!src || !isVinfoUrl(src)) return;
        try {
          const name = new URL(src, location.href).searchParams.get("callback");
          if (!name) {
            logDev("[Loom WeTV MAIN] getvinfo script has no callback param");
            return;
          }
          wrapJsonpCallback(name, src, cb);
        } catch {
          /* malformed url */
        }
      };

      const proto = HTMLScriptElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "src");
      if (desc?.set && desc.get) {
        const origSet = desc.set;
        const origGet = desc.get;
        Object.defineProperty(proto, "src", {
          configurable: true,
          enumerable: desc.enumerable,
          get(this: HTMLScriptElement) {
            return origGet.call(this);
          },
          set(this: HTMLScriptElement, v: string) {
            try {
              onScriptSrc(String(v));
            } catch {
              /* never break the page */
            }
            origSet.call(this, v);
          },
        });
      }

      const wrapInsert =
        (orig: (...a: unknown[]) => unknown) =>
        function (this: unknown, node: unknown, ...rest: unknown[]) {
          try {
            const el = node as { nodeName?: string; src?: string } | null;
            if (el && el.nodeName === "SCRIPT" && el.src) onScriptSrc(el.src);
          } catch {
            /* ignore */
          }
          return orig.call(this, node, ...rest);
        };
      Node.prototype.appendChild = wrapInsert(
        Node.prototype.appendChild as (...a: unknown[]) => unknown,
      ) as typeof Node.prototype.appendChild;
      Node.prototype.insertBefore = wrapInsert(
        Node.prototype.insertBefore as (...a: unknown[]) => unknown,
      ) as typeof Node.prototype.insertBefore;
    }

    /** Wrap the global JSONP callback named in the getvinfo URL. */
    function wrapJsonpCallback(
      name: string,
      url: string,
      cb: (json: unknown, url: string) => void,
    ): void {
      type Wrapped = ((...a: unknown[]) => unknown) & { __loomWrapped?: boolean };
      const obj = window as unknown as Record<string, Wrapped | undefined>;
      const makeWrapper = (fn: Wrapped | undefined): Wrapped => {
        const wfn = function (this: unknown, ...a: unknown[]) {
          try {
            cb(a[0], url);
          } catch {
            /* never break the page's callback */
          }
          return fn ? fn.apply(this, a) : undefined;
        } as Wrapped;
        wfn.__loomWrapped = true;
        return wfn;
      };

      const orig = obj[name];
      if (typeof orig === "function") {
        if (orig.__loomWrapped) return;
        obj[name] = makeWrapper(orig);
        logDev("[Loom WeTV MAIN] wrapped JSONP callback", name);
        return;
      }
      let stored: unknown = orig;
      Object.defineProperty(obj, name, {
        configurable: true,
        get() {
          return stored;
        },
        set(fn: Wrapped) {
          stored =
            typeof fn === "function" && !fn.__loomWrapped ? makeWrapper(fn) : fn;
        },
      });
      logDev("[Loom WeTV MAIN] deferred-wrap JSONP callback", name);
    }

    /** Backup: strip the JSONP wrapper from a fetch/XHR getvinfo body. */
    function installFetchHook(cb: (json: unknown, url: string) => void): void {
      const origFetch = window.fetch;
      window.fetch = function (
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const url = urlOf(input);
        const promise = origFetch.call(this, input, init);
        if (url && isVinfoUrl(url)) {
          promise
            .then((resp) =>
              resp
                .clone()
                .text()
                .then((t) => {
                  const j = stripJsonp(t);
                  if (j !== undefined) cb(j, url);
                })
                .catch(() => {}),
            )
            .catch(() => {});
        }
        return promise;
      } as typeof window.fetch;
    }

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
        if (url && isVinfoUrl(url)) {
          this.addEventListener("load", () => {
            const j = stripJsonp(this.responseText);
            if (j !== undefined) cb(j, url);
          });
        }
        return (origSend as (...a: unknown[]) => void).call(this, ...args);
      } as typeof XHR.send;
    }
  },
});

/** True for the getvinfo playback-descriptor request. */
function isVinfoUrl(url: string): boolean {
  return /\/getvinfo(?:$|[?])/.test(url);
}

/** Strip a `callback({...})` JSONP wrapper → parsed object (undefined if n/a). */
function stripJsonp(text: string): unknown {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** WeTV play id: the `vid` query param of the getvinfo URL. */
function vidFromUrl(url: string): string | null {
  const m = url.match(/[?&]vid=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
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
