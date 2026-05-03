// Romanize-batch helper: pre-resolve every unique target-event plain_text
// to its romanized form via POST /romanize, then expose a synchronous
// (text) => string lookup that LoomGenerator.romanize can plug into.
//
// LoomGenerator.romanize is sync by design — generateAssFile iterates
// thousands of events and shouldn't await per-event.  Pre-batching trades
// a single up-front fan-out (one HTTP request per unique text) for
// guaranteed-sync rendering downstream.  Identical events (very common in
// dialogue: "What?", "Yes.", "No.", song-lyric repeats) share one request.

import type { LoomClient } from "@loom/api-client";

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
  // Parallel fan-out.  A typical episode has ~300 unique events; the slim
  // API handles each in <50ms so the whole batch finishes in a few seconds.
  // If/when prod rate limits start biting, batch-shape the endpoint instead.
  const promises = [...unique].map(async (text) => {
    const { data, error } = await opts.client.POST("/romanize", {
      body: {
        text,
        lang_code: opts.lang_code,
        phonetic_system: opts.phonetic_system ?? null,
        long_vowel_mode: opts.long_vowel_mode ?? "macrons",
        opt_in_training: opts.opt_in_training ?? false,
      },
    });
    if (error) {
      throw new Error(`romanize failed for ${JSON.stringify(text).slice(0, 60)}: ${JSON.stringify(error)}`);
    }
    out.set(text, data?.romanized ?? "");
    done += 1;
    opts.on_progress?.(done, total);
  });
  await Promise.all(promises);
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
