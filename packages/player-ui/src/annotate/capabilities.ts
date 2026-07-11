// Server-declared dictionary capabilities (VOCAB_LOOKUP.md).
//
// The extension reads this at runtime so that WHICH languages are definable —
// and which gloss languages exist — is decided by the SERVER, not a hardcoded
// allowlist.  Adding a dictionary server-side then lights up in the already-
// installed extension with no new version.
//
// Fetched once per content-script session (module-cached promise).  A fresh
// page load re-fetches, so a newly-deployed dictionary appears on the next
// load — we deliberately do NOT persist it, to avoid a stale allowlist.

import { getApiClient } from "../api-client";
import { baseLang } from "./define-lang";

export interface DefineCapabilities {
  /** Base source-language codes that have a dictionary + tokenizer. */
  sourceLangs: Set<string>;
  /** Languages definitions can be written in (always includes "en"). */
  glossLangs: string[];
  /** Per source language, the gloss languages that actually have entries — so
      the "Dictionary language" picker offers only what's real for the video's
      language.  Absent/empty for a source → fall back to `glossLangs`.  Read it
      via glossLangsForSource() in define-lang.ts. */
  glossLangsBySource: Map<string, string[]>;
}

// Build-time fallback: the languages known to ship when this build was made, so
// a failed/absent capabilities call (old server, offline) still keeps the
// feature working.  It only ever narrows to this set when the endpoint is
// unreachable — it never overrides a live server response.
const FALLBACK: DefineCapabilities = {
  sourceLangs: new Set(["ja", "zh"]),
  glossLangs: ["en"],
  glossLangsBySource: new Map(),
};

let cached: Promise<DefineCapabilities> | null = null;

/** Cached per session.  Safe to await anywhere — resolves instantly after the
    first call. */
export function getDefineCapabilities(): Promise<DefineCapabilities> {
  if (!cached) cached = fetchCapabilities();
  return cached;
}

async function fetchCapabilities(): Promise<DefineCapabilities> {
  try {
    const { data } = await getApiClient().GET("/define/capabilities", {});
    if (data && Array.isArray(data.source_langs)) {
      const bySource = new Map<string, string[]>();
      const raw = data.gloss_langs_by_source;
      if (raw && typeof raw === "object") {
        for (const [lang, glosses] of Object.entries(raw)) {
          if (Array.isArray(glosses) && glosses.length) {
            bySource.set(baseLang(lang), glosses as string[]);
          }
        }
      }
      return {
        sourceLangs: new Set(data.source_langs.map(baseLang)),
        glossLangs:
          Array.isArray(data.gloss_langs) && data.gloss_langs.length
            ? data.gloss_langs
            : ["en"],
        glossLangsBySource: bySource,
      };
    }
  } catch {
    // fall through to the build-time fallback
  }
  return FALLBACK;
}
