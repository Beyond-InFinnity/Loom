// Single-shot batch annotation fetch.
//
// 5d-perf rewrite: replaces the per-text fan-out (one /annotate POST
// per unique text, fired in waves across the whole video as the
// rolling window advanced) with a single /annotate/batch request
// that returns all spans at once.
//
// Why:
// - Network: 1 POST per track instead of ~500.  Constant trickle
//   gone; users see one request and silence.
// - Rate limit: one slot of slowapi's 100/min instead of 500 (which
//   blew through the limit on long videos without owner-key bypass).
// - CPU: one React re-render with the populated map instead of ~500
//   incremental emits.
// - UX: ~3-4 second startup wait at activation, then never again
//   until track / phonetic-system change.  User experiences the
//   wait as part of "Loom warming up" not constant background work.
//
// The per-text fail-soft behavior is preserved: empty texts and
// texts beyond the server-side cap return `{spans: [], html: ""}`
// in the result, positionally aligned with the request — they show
// as plain rendering, not missing entries.

import { getApiClient } from "../api-client";
import { getOwnerKey } from "../owner-key";
import type { AnnotateMap, AnnotateSpan } from "./types";

const REQUEST_TIMEOUT_MS = 60_000;

export interface BuildAnnotateMapOptions {
  langCode: string;
  phoneticSystem?: string | null;
  optInTraining?: boolean;
  signal?: AbortSignal;
}

/** Fetch annotations for every unique text in `texts` in a single
    /annotate/batch request.  Returns Map<trimmedText, spans>.  On
    failure (network error, rate limit, etc.) returns an empty Map —
    overlay falls back to plain rendering until the next attempt.

    AbortController support: pass `signal` to cancel the in-flight
    request on track-switch / video-nav / settings change.  Internal
    60s deadline guards against server hangs (Railway cold start +
    ~3-4s annotation processing for a 700-text batch on the slow
    end). */
export async function buildAnnotateMap(
  texts: Iterable<string>,
  opts: BuildAnnotateMapOptions,
): Promise<AnnotateMap> {
  // Dedup + trim — server processes whatever we send, so smaller =
  // faster + cheaper.  Filter empty texts; backend returns empty
  // results for them but no need to ship the round-trip cost.
  const unique = Array.from(
    new Set(
      Array.from(texts)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  );

  const result: AnnotateMap = new Map();
  if (unique.length === 0) return result;

  const client = getApiClient();
  const ownerKey = await getOwnerKey();
  console.log(
    "[Loom Annotate] batch start:",
    "lang=" + opts.langCode,
    "system=" + (opts.phoneticSystem ?? "auto"),
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
    const { data, error, response } = await client.POST("/annotate/batch", {
      body: {
        texts: unique,
        lang_code: opts.langCode,
        phonetic_system: opts.phoneticSystem ?? null,
        opt_in_training: opts.optInTraining ?? false,
      },
      signal: requestCtrl.signal,
    });

    if (error) {
      const status = response?.status ?? 0;
      console.warn(
        "[Loom Annotate] /annotate/batch HTTP " + status,
        "for lang=" + opts.langCode + " — falling back to plain rendering.",
        status === 429
          ? "Rate-limited; set an owner key via the popup to bypass."
          : "",
        error,
      );
      return result;
    }

    if (!data || !Array.isArray(data.results)) {
      console.warn(
        "[Loom Annotate] /annotate/batch returned malformed response",
      );
      return result;
    }

    // Server result is positionally aligned with the request.  Some
    // entries may be empty (server-side filtered or oversized) — the
    // map simply won't have those keys, overlay falls back to plain.
    for (let i = 0; i < unique.length && i < data.results.length; i++) {
      const text = unique[i];
      const item = data.results[i];
      if (item && Array.isArray(item.spans) && item.spans.length > 0) {
        result.set(text, item.spans as AnnotateSpan[]);
      }
    }

    const dt = Math.round(performance.now() - t0);
    console.log(
      "[Loom Annotate] batch done:",
      "lang=" + opts.langCode,
      "requested=" + unique.length,
      "got_spans=" + result.size,
      "elapsed=" + dt + "ms",
    );
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      if (!opts.signal?.aborted) {
        console.warn(
          "[Loom Annotate] /annotate/batch timed out after",
          REQUEST_TIMEOUT_MS + "ms for lang=" + opts.langCode,
        );
      }
      return result;
    }
    console.warn(
      "[Loom Annotate] /annotate/batch threw for lang=" + opts.langCode,
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
