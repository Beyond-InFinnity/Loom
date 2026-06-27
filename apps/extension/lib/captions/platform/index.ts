// Platform resolution — pick the CaptionPlatform for the current page.
//
// discover.ts calls getPlatform() once (memoized).  A null result means
// the current host isn't a supported streaming site, so no caption work
// runs.  In practice the content scripts only inject on supported hosts,
// so null is a defensive fallback rather than an expected path.

import type { CaptionPlatform } from "./types";
import { youtubePlatform } from "./youtube";
import { netflixPlatform } from "./netflix";
import { crunchyrollPlatform } from "./crunchyroll";

let resolved: CaptionPlatform | null | undefined = undefined;

export function getPlatform(): CaptionPlatform | null {
  if (resolved !== undefined) return resolved;
  const host = location.hostname;
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    resolved = youtubePlatform;
  } else if (host === "netflix.com" || host.endsWith(".netflix.com")) {
    resolved = netflixPlatform;
  } else if (host === "crunchyroll.com" || host.endsWith(".crunchyroll.com")) {
    resolved = crunchyrollPlatform;
  } else {
    resolved = null;
  }
  return resolved;
}

export type {
  CaptionPlatform,
  SessionAcquisition,
  FetchTrackOpts,
} from "./types";
