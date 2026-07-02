// Romanize-batch helper: pre-resolve every unique target-event plain_text
// to its romanized form via POST /romanize/batch, then expose a synchronous
// (text) => string lookup that LoomGenerator.romanize can plug into.
//
// LoomGenerator.romanize is sync by design — generateAssFile iterates
// thousands of events and shouldn't await per-event.  Pre-batching trades
// a single up-front request for guaranteed-sync rendering downstream.
//
// Migrated 2026-07-02 from a per-unique-text POST /romanize fan-out to
// /romanize/batch (the endpoint the extension has used since 5e): a whole
// episode is now ONE request instead of ~300 — one slowapi slot instead of
// a burst that flirted with the 100/min limit, and one trip through the
// server's content-addressed result cache.

import type { LoomClient } from "@loom/api-client";

// Server cap on texts per /romanize/batch request (loom_api/routes/
// romanize.py _BATCH_MAX_TEXTS).  A FastAPI max_length violation 422s the
// whole request, so chunk client-side.  Typical episodes (~300 unique)
// fit in one chunk.
const BATCH_MAX_TEXTS = 2000;

export interface BuildRomanizeMapOptions {
  client: LoomClient;
  lang_code: string;
  phonetic_system?: string;
  /** Japanese-only.  macrons | doubled | unmarked.  Server ignores for
      other languages, so it's fine to pass unconditionally. */
  long_vowel_mode?: string;
  texts: Iterable<string>;
  /** Called as each request resolves so the caller can show progress. */
  on_progress?: (done: number, total: number) => void;
  /** Caller can opt in to OCR archival — passed through to the API. */
  opt_in_training?: boolean;
}

/** Resolve every unique non-empty text via /romanize.  Throws on the first
    error so the caller can surface it once instead of getting partial
    output. */
export async function buildRomanizeMap(
  opts: BuildRomanizeMapOptions,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = new Set<string>();
  for (const t of opts.texts) {
    if (t && t.trim()) unique.add(t);
  }
  const total = unique.size;
  if (total === 0) return out;

  let done = 0;
  const texts = [...unique];
  for (let offset = 0; offset < texts.length; offset += BATCH_MAX_TEXTS) {
    const chunk = texts.slice(offset, offset + BATCH_MAX_TEXTS);
    const { data, error } = await opts.client.POST("/romanize/batch", {
      body: {
        texts: chunk,
        lang_code: opts.lang_code,
        phonetic_system: opts.phonetic_system ?? null,
        long_vowel_mode: opts.long_vowel_mode ?? "macrons",
        opt_in_training: opts.opt_in_training ?? false,
      },
    });
    if (error || !data) {
      throw new Error(`romanize batch failed: ${JSON.stringify(error ?? "no data")}`);
    }
    // Positional contract: results[i] pairs with chunk[i]; empty strings
    // for unsupported languages / oversized texts (fail-soft, matches the
    // old per-text behavior of "no romanization → skip layer").
    data.results.forEach((item, i) => {
      out.set(chunk[i], item.romanized ?? "");
    });
    done += chunk.length;
    opts.on_progress?.(done, total);
  }
  return out;
}

/** Wrap a pre-built romanize map in the (text) => string signature
    LoomGenerator.romanize expects.  Missing keys (e.g. text the caller
    didn't include in `texts`) return empty string rather than undefined,
    matching pysubs2's "no romanization available → skip layer" semantics. */
export function romanizeFromMap(map: Map<string, string>): (text: string) => string {
  return (text) => map.get(text) ?? "";
}

/** Probe the API for whether a language has a phonetic layer at all.
    Used to short-circuit /romanize fan-out for langs like English. */
export async function hasPhoneticLayer(
  client: LoomClient,
  lang_code: string,
  phonetic_system?: string,
): Promise<boolean> {
  const { data, error } = await client.GET("/language/config/{code}", {
    params: {
      path: { code: lang_code },
      query: phonetic_system ? { phonetic_system } : {},
    },
  });
  if (error || !data) return false;
  return data.has_phonetic_layer;
}
