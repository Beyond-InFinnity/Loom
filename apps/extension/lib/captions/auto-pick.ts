// Auto-pick target + native tracks from a YouTube tracklist.
//
// Generic by design — no per-language hardcoded list.  Decisions
// derive from BCP-47 parsing + script-family classification (see
// ./lang-code.ts and ./lang-support.ts).  Adding a Roman-alphabet
// language is automatic; adding a non-Latin script needs one entry
// in lang-support.ts.  Regional dialects (en-US / en-GB / pt-BR /
// pt-PT / es-419) collapse via base-language matching, so we don't
// enumerate "every variant of English a video might have."
//
// Two questions to answer per tracklist:
//
//   1. Which track is the user's NATIVE language?  (Bottom layer.)
//      Matched by canonical base language subtag — so en, en-US,
//      en-GB, en-AU, en-IN all match a native preference of "en".
//      Within the match set, prefer manual over ASR.
//
//   2. Which track is the FOREIGN target?  (Top layer.)
//      Any non-native track is eligible.  Rank by processing tier:
//        T1 annotate-romanize  CJK (ja, ko, zh, yue) — headline demo
//        T2 romanize           Cyrillic / Thai / Indic / Hebrew /
//                              Arabic family
//        T3 native-display     Latin-script (de, fr, es, pt, it, vi,
//                              tr, id, fil, sw, pl, cs, …)
//        T4 unsupported        Script without a pipeline; still shown
//                              as raw text — dual-subs is valuable on
//                              its own
//      Within tier, manual > ASR.
//
// User-pref overrides (e.g., "prefer Spanish over Japanese as target")
// land in 5f when the settings UI exposes target language selection.
// Until then, this function is the auto-default; 5f will plumb a
// `preferredLangs` parameter through.

import type { CaptionTrack } from "./types";
import { classifyLang, sameBaseLang, type Processing } from "./lang-support";

const TIER_ORDER: Processing[] = [
  "annotate-romanize",
  "romanize",
  "native-display",
  "unsupported",
];

const DEFAULT_NATIVE_LANG = "en";

export interface AutoPickResult {
  target: CaptionTrack | null;
  native: CaptionTrack | null;
}

export function autoPick(
  tracks: CaptionTrack[],
  nativeLang: string = DEFAULT_NATIVE_LANG,
): AutoPickResult {
  return {
    target: pickTarget(tracks, nativeLang),
    native: pickNative(tracks, nativeLang),
  };
}

/** Pick the user's native-language track.  Matches by canonical base
    language subtag, so all regional variants of the user's language
    (en-US / en-GB / en-AU / en-IN / en-ZA / …) are eligible.  Within
    the match set, prefer manual over ASR. */
export function pickNative(
  tracks: CaptionTrack[],
  nativeLang: string,
): CaptionTrack | null {
  const matches = tracks.filter((t) =>
    sameBaseLang(t.languageCode, nativeLang),
  );
  if (matches.length === 0) return null;
  return preferManual(matches);
}

/** Pick the foreign-language target track.  Anything that isn't the
    user's native language is eligible.  Tier-rank by processing
    capability; within tier, prefer manual over ASR.

    Returns null only when every track shares the user's native base
    language (e.g., an English-only video for an English user). */
export function pickTarget(
  tracks: CaptionTrack[],
  nativeLang: string,
): CaptionTrack | null {
  const foreign = tracks.filter(
    (t) => !sameBaseLang(t.languageCode, nativeLang),
  );
  if (foreign.length === 0) return null;

  for (const tier of TIER_ORDER) {
    const tierMatches = foreign.filter(
      (t) => classifyLang(t.languageCode).processing === tier,
    );
    if (tierMatches.length === 0) continue;
    return preferManual(tierMatches);
  }
  // TIER_ORDER covers every Processing value so this is structurally
  // unreachable; the explicit return keeps the type checker happy.
  return foreign[0];
}

function preferManual(tracks: CaptionTrack[]): CaptionTrack {
  return tracks.find((t) => t.kind === "manual") ?? tracks[0];
}
