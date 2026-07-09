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

import { getApiClient } from "@/lib/api-client";
import { baseLang } from "./define-lang";

export interface DefineCapabilities {
  /** Base source-language codes that have a dictionary + tokenizer. */
  sourceLangs: Set<string>;
  /** Languages definitions can be written in (always includes "en"). */
  glossLangs: string[];
}

// Build-time fallback: the languages known to ship when this build was made, so
// a failed/absent capabilities call (old server, offline) still keeps the
// feature working.  It only ever narrows to this set when the endpoint is
// unreachable — it never overrides a live server response.
const FALLBACK: DefineCapabilities = {
  sourceLangs: new Set(["ja", "zh"]),
  glossLangs: ["en"],
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
      return {
        sourceLangs: new Set(data.source_langs.map(baseLang)),
        glossLangs:
          Array.isArray(data.gloss_langs) && data.gloss_langs.length
            ? data.gloss_langs
            : ["en"],
      };
    }
  } catch {
    // fall through to the build-time fallback
  }
  return FALLBACK;
}
