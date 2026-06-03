// First-pot-by-firing-order URL picker.
//
// 5c diagnostic spike (2026-05-20) confirmed YouTube fires multiple
// /api/timedtext requests per video — a natural page-load prefetch
// (~t=53ms, with pot) plus any requests our CC trigger produces (with
// pot) plus any later requests fired by a user manually clicking YT's
// own CC button (NO pot, 124-char shorter URL).  Last-write-wins on a
// single-URL Map picked the user-click no-pot URLs and our lang-swap
// fetch returned empty bodies.
//
// Pot is session-bound, not language-bound — one pot URL fans out to
// every language via lang-swap.  So any pot-bearing URL works; we just
// need a deterministic discriminator that excludes the no-pot ones.
//
// First-pot-by-firing-order:
//   - structurally immune to late no-pot requests overwriting earlier
//     good captures (a user click after we've already tracked won't
//     break us)
//   - deterministic across runs
//   - immune to YT shuffling around which c=/sparams=/sig= shapes are
//     in use today vs tomorrow; the only feature we depend on is
//     `pot` being present

/** Minimal shape the picker requires.  Background's `CapturedReq` is
    wider than this; the type parameter T preserves the original shape
    through the call so the caller doesn't lose fields. */
export interface CapturedReqMin {
  order: number;
  url: string;
  params: { potLen: number };
}

/** Return the first captured request (by firing order) whose pot value
    is non-empty AND whose signed URL has not expired, or null if no
    captured request carries a pot.  Does NOT fall back to a no-pot URL —
    empty pot reliably produces empty response bodies, so returning one
    is worse than returning null.

    EXPIRY (2026-06-04): the background page is persistent in Firefox MV2,
    so `capturedAll` survives page reloads + new tabs for the whole
    browser session.  Re-watching a video appends a fresh prefetch URL to
    an array that still holds the FIRST watch's URL — and plain
    first-pot-by-order then returns that hours-old, now-expired URL, which
    YouTube 404s.  (New videos worked; previously-watched ones broke, with
    no page-level reload able to fix it — the staleness lives in the
    background, not the page.)  YouTube stamps `&expire=<unix seconds>` in
    the signed URL; we skip any pot URL whose expire is in the past so the
    freshly-captured sibling wins.  URLs with no `expire` param are never
    skipped (back-compat — only drop one when we positively know it's
    dead).  `now` is injectable for tests. */
export function pickPotBearingUrl<T extends CapturedReqMin>(
  arr: readonly T[],
  now: number = Date.now(),
): T | null {
  let firstPot: T | null = null;
  for (const req of arr) {
    if (req.params.potLen <= 0) continue;
    if (firstPot === null) firstPot = req;
    if (!isExpiredUrl(req.url, now)) return req;
  }
  // Every pot-bearing URL is expired (or there are none).  Returning the
  // first pot URL preserves the prior behavior for that edge case; in the
  // common re-watch case the loop above already returned the fresh one.
  return firstPot;
}

/** True only when the URL carries an `expire=<unix seconds>` param that
    is in the past.  No param → not expired (we don't guess). */
function isExpiredUrl(url: string, now: number): boolean {
  const m = /[?&]expire=(\d+)/.exec(url);
  if (!m) return false;
  const expireMs = Number(m[1]) * 1000;
  return Number.isFinite(expireMs) && expireMs <= now;
}
