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

/** Return the FIRST captured request (by firing order) whose pot value
    is non-empty, or null if no captured request carries a pot.  Does
    NOT fall back to a no-pot URL — empty pot reliably produces empty
    response bodies, so returning one is worse than returning null. */
export function pickPotBearingUrl<T extends CapturedReqMin>(
  arr: readonly T[],
): T | null {
  for (const req of arr) {
    if (req.params.potLen > 0) return req;
  }
  return null;
}
