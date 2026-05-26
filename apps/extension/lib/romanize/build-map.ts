// Single-shot batch romanization fetch (5e).
//
// Paired with buildAnnotateMap: one /annotate/batch request gives
// per-token ruby spans (5d, CJK + Korean), one /romanize/batch
// request gives full-utterance romanization (5e — the secondary
// phonetic line above the foreign text, and the entire phonetic
// surface for non-CJK families: Cyrillic / Thai / Indic / Hebrew /
// Arabic-Persian-Urdu).
//
// Same architecture lock as 5d-perf: one HTTP request per (track,
// phonetic-system) on activation, ~3-4s wait, then silence for the
// rest of playback.  One slowapi slot per video instead of N.
//
// The per-text fail-soft behavior matches /annotate/batch: empty /
// oversized texts return {romanized: ""} and are simply absent from
// the resulting Map — the overlay renders nothing in the Romanization
// slot for those events, never a missing-key error.

import { getApiClient } from "../api-client";
import { getOwnerKey } from "../owner-key";
import type { RomanizeMap } from "./types";

const REQUEST_TIMEOUT_MS = 60_000;

export interface BuildRomanizeMapOptions {
  langCode: string;
  phoneticSystem?: string | null;
  /** Japanese-specific.  Threaded through to every text in the batch.
      Ignored by other languages but cheap to pass unconditionally. */
  longVowelMode?: "macrons" | "doubled" | "unmarked";
  optInTraining?: boolean;
  signal?: AbortSignal;
}

/** Fetch full-utterance romanization for every unique text in
    `texts` in a single /romanize/batch request.  Returns
    Map<trimmedText, romanized>.  On failure (network error, rate
    limit, no phonetic layer for the language, etc.) returns an empty
    Map — overlay falls back to rendering nothing in the Romanization
    slot until the next attempt.

    AbortController support: pass `signal` to cancel the in-flight
    request on track-switch / video-nav / settings change.  Internal
    60s deadline guards against server hangs (matches
    buildAnnotateMap's budget). */
export async function buildRomanizeMap(
  texts: Iterable<string>,
  opts: BuildRomanizeMapOptions,
): Promise<RomanizeMap> {
  // Dedup + trim — same shape as buildAnnotateMap.  Smaller batch =
  // faster + cheaper; backend tolerates empty entries but no need to
  // ship the round-trip cost.
  const unique = Array.from(
    new Set(
      Array.from(texts)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  );

  const result: RomanizeMap = new Map();
  if (unique.length === 0) return result;

  const client = getApiClient();
  const ownerKey = await getOwnerKey();
  console.log(
    "[Loom Romanize] batch start:",
    "lang=" + opts.langCode,
    "system=" + (opts.phoneticSystem ?? "auto"),
    "long_vowel=" + (opts.longVowelMode ?? "macrons"),
    "unique_texts=" + unique.length,
    "owner_key=" + (ownerKey ? "set" : "MISSING"),
  );

  // Per-request timeout combined with parent signal.  Without this,
  // a server stall could leave the activation in "loading" forever.
  const requestCtrl = new AbortController();
  const timeoutId = setTimeout(
    () => requestCtrl.abort(),
    REQUEST_TIMEOUT_MS,
  );
  const parentAbortListener = () => requestCtrl.abort();
  if (opts.signal) {
    opts.signal.addEventListener("abort", parentAbortListener, {
      once: true,
    });
  }

  const t0 = performance.now();
  try {
    const { data, error, response } = await client.POST("/romanize/batch", {
      body: {
        texts: unique,
        lang_code: opts.langCode,
        phonetic_system: opts.phoneticSystem ?? null,
        long_vowel_mode: opts.longVowelMode ?? "macrons",
        opt_in_training: opts.optInTraining ?? false,
      },
      signal: requestCtrl.signal,
    });

    if (error) {
      const status = response?.status ?? 0;
      console.warn(
        "[Loom Romanize] /romanize/batch HTTP " + status,
        "for lang=" + opts.langCode + " — falling back to no romanization line.",
        status === 429
          ? "Rate-limited; set an owner key via the popup to bypass."
          : "",
        error,
      );
      return result;
    }

    if (!data || !Array.isArray(data.results)) {
      console.warn(
        "[Loom Romanize] /romanize/batch returned malformed response",
      );
      return result;
    }

    if (!data.has_phonetic_layer) {
      // Language has no romanization at all (Latin / unsupported).
      // Backend already returned all-empty results; surface the fact
      // in the log so a confused operator can tell "no phonetic line"
      // from "phonetic line failed to fetch".
      console.log(
        "[Loom Romanize] lang=" + opts.langCode +
        " has no phonetic layer — returning empty map.",
      );
      return result;
    }

    // Positional alignment with the request: result[i] ↔ unique[i].
    // Empty entries (server-side filtered or oversized) are simply
    // not inserted; the overlay falls back to nothing for those keys.
    for (let i = 0; i < unique.length && i < data.results.length; i++) {
      const text = unique[i];
      const item = data.results[i];
      if (item && typeof item.romanized === "string" && item.romanized.length > 0) {
        result.set(text, item.romanized);
      }
    }

    const dt = Math.round(performance.now() - t0);
    console.log(
      "[Loom Romanize] batch done:",
      "lang=" + opts.langCode,
      "requested=" + unique.length,
      "got_romanized=" + result.size,
      "elapsed=" + dt + "ms",
    );
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      if (!opts.signal?.aborted) {
        console.warn(
          "[Loom Romanize] /romanize/batch timed out after",
          REQUEST_TIMEOUT_MS + "ms for lang=" + opts.langCode,
        );
      }
      return result;
    }
    console.warn(
      "[Loom Romanize] /romanize/batch threw for lang=" + opts.langCode,
      err.message,
    );
  } finally {
    clearTimeout(timeoutId);
    if (opts.signal) {
      opts.signal.removeEventListener("abort", parentAbortListener);
    }
  }

  return result;
}
