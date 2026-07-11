// Romanization map cache, keyed by (videoId, lang, phoneticSystem, longVowelMode).
//
// Mirrors annotate/cache.ts.  The extra key component is
// longVowelMode, which is Japanese-specific but cheap to thread
// through unconditionally — keeps non-Japanese cache keys identical
// across mode flips (the value just doesn't vary).
//
// Cleared only on session restart.  Per-video footprint is roughly
// the same scale as the annotate map (~20KB for a 25-min episode),
// so the unbounded growth isn't a real concern.

import type { RomanizeMap } from "./types";

const cache = new Map<string, RomanizeMap>();

export function romanizeCacheKey(
  videoId: string,
  lang: string,
  phoneticSystem: string | null,
  longVowelMode: string,
): string {
  return `${videoId}::${lang}::${phoneticSystem ?? ""}::${longVowelMode}`;
}

export function getCachedRomanizeMap(key: string): RomanizeMap | null {
  return cache.get(key) ?? null;
}

export function setCachedRomanizeMap(key: string, map: RomanizeMap): void {
  cache.set(key, map);
}

export function clearRomanizeCache(): void {
  cache.clear();
}
