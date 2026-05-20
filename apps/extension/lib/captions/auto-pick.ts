import type { CaptionTrack } from "./types";

// Auto-pick rule for v1.  Scan discovered tracks in preference order
// for the languages our romanization engine supports best at the moment
// (ja + Chinese family per project_step5_is_the_headline.md).  First
// match wins.
//
// Korean, Thai, Indic, Hebrew, Arabic etc. land via 5f when the
// settings UI exposes user-selected target language — at that point
// this preference list becomes a fallback for "no user choice yet."
//
// Manual captions are preferred over ASR within the same language
// (ASR has worse punctuation + misrecognizes proper nouns) but ASR is
// accepted when it's the only option.

const PREFERRED_LANGS = [
  "ja",
  "zh-Hans",
  "zh-Hant",
  "zh-CN",
  "zh-TW",
  "zh-HK",
  "zh",
  "yue",
] as const;

export type SupportedLang = (typeof PREFERRED_LANGS)[number];

export function autoPickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  for (const lang of PREFERRED_LANGS) {
    const matches = tracks.filter((t) => normalizeLang(t.languageCode) === lang);
    if (matches.length === 0) continue;
    // Prefer manual over ASR within a language.
    const manual = matches.find((t) => t.kind === "manual");
    return manual ?? matches[0];
  }
  return null;
}

/** Normalize YouTube's BCP-47 lang code variants to our preference list.
    YouTube uses "zh-CN", "zh-TW", etc. — pass through.  Some videos
    have "ja-JP" which we normalize to "ja". */
function normalizeLang(code: string): string {
  const trimmed = code.trim();
  if (trimmed.startsWith("ja")) return "ja";
  if (trimmed === "yue" || trimmed === "yue-HK") return "yue";
  return trimmed;
}
