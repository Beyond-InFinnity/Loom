// Background script — captures YouTube timedtext URLs as they fire.
//
// 5b spike: when the user (or our content script's programmatic CC click)
// enables captions on a YouTube watch page, YouTube's own player fires a
// GET to /api/timedtext?v=...&pot=...&c=WEB&signature=...&lang=...&fmt=...
// The `pot` is the BotGuard-minted PO token — the one thing we can't
// produce ourselves.  We observe the URL via webRequest, store it keyed
// by videoId, and hand it back to the content script on request.  The
// content script then clones the URL and swaps the `lang` param to fetch
// every other track's events (the lang-swap assumption being verified by
// the spike harness).
//
// MV3 webRequest is observation-only — we don't need to block or rewrite,
// just read the URL string off onBeforeRequest.
//
// In-memory Map only.  Tokens expire (~hours per BotGuard's session
// binding) and we don't want stale URLs persisted across browser restarts.

interface CapturedUrl {
  url: string;
  capturedAt: number;
}

const captured = new Map<string, CapturedUrl>();

export default defineBackground(() => {
  browser.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      try {
        const u = new URL(details.url);
        const videoId = u.searchParams.get("v");
        if (!videoId) return undefined;
        captured.set(videoId, { url: details.url, capturedAt: Date.now() });
        console.log(
          "[Loom BG] captured timedtext URL for video",
          videoId,
          "(lang=" + u.searchParams.get("lang") + ")",
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
    if (!msg || msg.type !== "GET_CAPTURED_URL") return;
    const videoId = msg.videoId;
    if (typeof videoId !== "string") {
      sendResponse({ url: null });
      return;
    }
    const entry = captured.get(videoId);
    sendResponse({
      url: entry?.url ?? null,
      capturedAt: entry?.capturedAt ?? null,
    });
    // Return true to indicate we'll call sendResponse synchronously in
    // some browsers; safe to omit but defensive in case onMessage
    // semantics change.
    return true;
  });
});
