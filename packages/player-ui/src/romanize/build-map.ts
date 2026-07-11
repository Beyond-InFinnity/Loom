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
import { loomHost } from "../host";
import { logDebug } from "../log";
import type { RomanizeMap } from "./types";

const REQUEST_TIMEOUT_MS = 60_000;

// The /romanize/batch server cap is 2000 texts per request (Pydantic
// max_length → HTTP 422 over it) — a dense feature-length track exceeds
// it (Evangelion 3.33: 2064 unique lines → 422 → no romanization line).
// Chunk under the cap and fan out in parallel; a no-op single request for
// ordinary videos.  Mirrors buildAnnotateMap.
const CHUNK_SIZE = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  const ownerKey = await loomHost().api.ownerKey();
  const chunks = chunk(unique, CHUNK_SIZE);
  logDebug(
    "[Loom Romanize] batch start:",
    "lang=" + opts.langCode,
    "system=" + (opts.phoneticSystem ?? "auto"),
    "long_vowel=" + (opts.longVowelMode ?? "macrons"),
    "unique_texts=" + unique.length,
    "chunks=" + chunks.length,
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
    // One /romanize/batch per chunk, in parallel; independent chunks so
    // one failure doesn't sink the rest (mirrors buildAnnotateMap).
    const responses = await Promise.all(
      chunks.map((texts) =>
        client.POST("/romanize/batch", {
          body: {
            texts,
            lang_code: opts.langCode,
            phonetic_system: opts.phoneticSystem ?? null,
            long_vowel_mode: opts.longVowelMode ?? "macrons",
            opt_in_training: opts.optInTraining ?? false,
          },
          signal: requestCtrl.signal,
        }),
      ),
    );

    let sawPhoneticLayer = false;
    responses.forEach(({ data, error, response }, c) => {
      if (error) {
        const status = response?.status ?? 0;
        console.warn(
          "[Loom Romanize] /romanize/batch HTTP " + status,
          "for lang=" + opts.langCode + " chunk " + c +
            " — those texts get no romanization line.",
          status === 429
            ? "Rate-limited; set an owner key via the popup to bypass."
            : "",
          error,
        );
        return;
      }
      if (!data || !Array.isArray(data.results)) {
        console.warn(
          "[Loom Romanize] /romanize/batch returned malformed response (chunk " + c + ")",
        );
        return;
      }
      if (data.has_phonetic_layer) sawPhoneticLayer = true;
      // Positional alignment with THIS chunk's texts.
      const texts = chunks[c];
      for (let i = 0; i < texts.length && i < data.results.length; i++) {
        const item = data.results[i];
        if (item && typeof item.romanized === "string" && item.romanized.length > 0) {
          result.set(texts[i], item.romanized);
        }
      }
    });

    if (!sawPhoneticLayer && result.size === 0) {
      // Language has no romanization at all (Latin / unsupported).
      logDebug(
        "[Loom Romanize] lang=" + opts.langCode +
        " has no phonetic layer — returning empty map.",
      );
      return result;
    }

    const dt = Math.round(performance.now() - t0);
    logDebug(
      "[Loom Romanize] batch done:",
      "lang=" + opts.langCode,
      "requested=" + unique.length,
      "chunks=" + chunks.length,
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
