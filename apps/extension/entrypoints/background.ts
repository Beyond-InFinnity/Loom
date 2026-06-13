// Background script — captures YouTube timedtext URLs as they fire,
// then returns the first pot-bearing one on demand.
//
// 5b shipped a last-write-wins Map<videoId, capturedUrl>.  The 5c
// diagnostic spike on 2026-05-20 revealed YT fires multiple timedtext
// requests per video: an early page-load prefetch (~t=53ms, with pot),
// our CC-trigger response (with pot), and any later user-clicked CC
// responses (NO pot, 124-char shorter URL).  Last-write-wins picked
// the user-click no-pot URLs, lang-swap returned empty bodies.
//
// 5c fix:
//   - Capture EVERY timedtext request into a per-videoId array.
//   - GET_CAPTURED_URL returns the FIRST pot-bearing URL by firing
//     order (first-pot-wins — see lib/captions/url-picker.ts for the
//     rationale).  Returns null if no pot URL has been captured yet.
//   - GET_ALL_TIMEDTEXT_URLS exposes the raw array for diagnostics.
//
// Pot is session-bound, not language-bound — one captured pot URL
// fans out to every language via lang-swap, so any pot URL is a
// usable URL; we just need to skip the no-pot ones reliably.
//
// MV3 webRequest is observation-only — we don't block or rewrite.

import { getEnabled, onEnabledChanged } from "@/lib/enabled";
import { logDev } from "@/lib/env";
import { pickPotBearingUrl } from "@/lib/captions/url-picker";

interface CapturedReq {
  /** Insertion order — 0-indexed, monotonically increasing per videoId. */
  order: number;
  /** performance.now() at capture time.  Relative ordering inside a
      single page load; absolute value depends on when the background
      service worker last started. */
  tMs: number;
  /** Full request URL (long — be ready for ~600 chars). */
  url: string;
  /** Total URL string length, for quick eyeballing. */
  urlLen: number;
  params: {
    pot: boolean;
    potc: boolean;
    c: boolean;
    cver: boolean;
    signature: boolean;
    sparams: boolean;
    expire: boolean;
    lang: boolean;
    tlang: boolean;
    fmt: boolean;
    caps: boolean;
    kind: boolean;
    xosf: boolean;
    /** Length of the pot= value, 0 if absent.  This is the picker's
        only discriminator — see url-picker.ts for why we don't also
        require c=WEB / sparams / signature. */
    potLen: number;
    c_value: string | null;
    lang_value: string | null;
  };
}

const capturedAll = new Map<string, CapturedReq[]>();
const orderCounter = new Map<string, number>();

function paramBreakdown(u: URL): CapturedReq["params"] {
  const has = (k: string) => u.searchParams.has(k);
  const pot = u.searchParams.get("pot");
  return {
    pot: has("pot"),
    potc: has("potc"),
    c: has("c"),
    cver: has("cver"),
    signature: has("signature"),
    sparams: has("sparams"),
    expire: has("expire"),
    lang: has("lang"),
    tlang: has("tlang"),
    fmt: has("fmt"),
    caps: has("caps"),
    kind: has("kind"),
    xosf: has("xosf"),
    potLen: pot ? pot.length : 0,
    c_value: u.searchParams.get("c"),
    lang_value: u.searchParams.get("lang"),
  };
}

export default defineBackground(() => {
  // Cached mirror of the global kill switch (lib/enabled.ts). The
  // webRequest listener is synchronous, so it can't await storage — we keep
  // a module-local boolean primed at startup and kept fresh via
  // onEnabledChanged. When Loom is off, the listener early-returns and
  // captures nothing, so a disabled browser does zero timedtext observation.
  // Defaults to true (fail-open) until the first read resolves.
  let enabled = true;
  getEnabled()
    .then((e) => {
      enabled = e;
    })
    .catch(() => {
      enabled = true;
    });
  onEnabledChanged((e) => {
    enabled = e;
  });

  browser.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      if (!enabled) return undefined;
      try {
        const u = new URL(details.url);
        const videoId = u.searchParams.get("v");
        if (!videoId) return undefined;

        const order = orderCounter.get(videoId) ?? 0;
        orderCounter.set(videoId, order + 1);

        const params = paramBreakdown(u);
        const req: CapturedReq = {
          order,
          tMs: performance.now(),
          url: details.url,
          urlLen: details.url.length,
          params,
        };
        const arr = capturedAll.get(videoId) ?? [];
        arr.push(req);
        capturedAll.set(videoId, arr);

        // One-line summary at capture time — useful both for the
        // happy path (confirms a pot URL was seen) and for the
        // observability path (if the picker ever returns null we can
        // scroll back and see what was rejected).
        logDev(
          "[Loom BG] capture #" + order +
            " video=" + videoId +
            " urlLen=" + details.url.length +
            " lang=" + params.lang_value +
            " c=" + params.c_value +
            " pot=" + params.pot +
            " potLen=" + params.potLen +
            (params.potLen === 0
              ? " (REJECTED by picker — no pot)"
              : ""),
        );
      } catch {
        // ignore malformed URLs
      }
      return undefined;
    },
    { urls: ["*://*.youtube.com/api/timedtext*"] },
  );

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string; videoId?: string } | undefined;
    if (!msg) return;

    if (msg.type === "GET_CAPTURED_URL") {
      const videoId = msg.videoId;
      if (typeof videoId !== "string") {
        sendResponse({ url: null });
        return true;
      }
      const arr = capturedAll.get(videoId) ?? [];
      const picked = pickPotBearingUrl(arr);
      sendResponse({
        url: picked?.url ?? null,
        capturedAt: picked ? picked.tMs : null,
      });
      return true;
    }

    if (msg.type === "GET_ALL_TIMEDTEXT_URLS") {
      const videoId = msg.videoId;
      if (typeof videoId !== "string") {
        sendResponse({ requests: [] });
        return true;
      }
      sendResponse({ requests: capturedAll.get(videoId) ?? [] });
      return true;
    }

    return;
  });
});
