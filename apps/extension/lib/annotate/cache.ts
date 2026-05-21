// Annotation map cache, keyed by (videoId, lang, phoneticSystem).
//
// One map per (track, phonetic-system) tuple — switching phonetic
// system on the same track rebuilds the map from scratch (different
// reading → different ruby), but switching BACK to a previously-used
// system is instant from cache.  Switching tracks across videos lands
// in different cache entries naturally; old entries stay in memory
// for the session but never collide with new ones because videoId
// participates in the key.
//
// Cleared only on session restart.  Per-video footprint is small
// (~20KB for a typical 25-min episode of Chinese), so the unbounded
// growth isn't a real concern over a normal browsing session.

import type { AnnotateMap } from "./types";

const cache = new Map<string, AnnotateMap>();

export function annotateCacheKey(
  videoId: string,
  lang: string,
  phoneticSystem: string | null,
): string {
  return `${videoId}::${lang}::${phoneticSystem ?? ""}`;
}

export function getCachedAnnotateMap(key: string): AnnotateMap | null {
  return cache.get(key) ?? null;
}

export function setCachedAnnotateMap(key: string, map: AnnotateMap): void {
  cache.set(key, map);
}

export function clearAnnotateCache(): void {
  cache.clear();
}
