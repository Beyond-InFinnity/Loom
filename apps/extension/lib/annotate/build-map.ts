// Parallel /annotate fan-out for a list of event texts.
//
// Mirrors the apps/web/lib/api/romanize.ts::buildRomanizeMap shape:
// dedup unique texts, fan out one /annotate POST per unique text,
// build a Map<text, spans>.  Bounded concurrency keeps us polite to
// the slim API even though owner-key bypass means we're not actually
// rate-limited.
//
// Fail-soft: an individual /annotate failure logs a warning and skips
// that text.  The map omits the failing entry, the caller falls back
// to rendering plain base text for those events.  Whole pipeline does
// NOT throw on partial failure.
//
// AbortController: pass `signal` from the caller (track-switch,
// video navigation, or settings change).  In-flight requests cancel
// and unwind the worker pool gracefully.

import { getApiClient } from "../api-client";
import type { AnnotateMap, AnnotateSpan } from "./types";

const DEFAULT_CONCURRENCY = 10;

export interface BuildAnnotateMapOptions {
  /** BCP-47 lang code for the texts being annotated. */
  langCode: string;
  /** Optional phonetic-system override (pinyin / zhuyin / jyutping /
      rtgs / paiboon / ipa).  null = backend decides via lang's
      default. */
  phoneticSystem?: string | null;
  /** Default false until 5+ archival pipeline lands. */
  optInTraining?: boolean;
  /** Max in-flight requests.  Default 10. */
  concurrency?: number;
  /** Cancellation signal — when aborted, workers stop dequeueing and
      the function rejects with AbortError. */
  signal?: AbortSignal;
  /** Progress callback fires after each request resolves (success or
      failure). */
  onProgress?: (done: number, total: number) => void;
}

export async function buildAnnotateMap(
  texts: Iterable<string>,
  opts: BuildAnnotateMapOptions,
): Promise<AnnotateMap> {
  // Dedup: many events repeat short utterances ("Hai.", "そうです.")
  // and event lists frequently contain blank/placeholder rows.  One
  // request per unique non-empty string.
  const unique = Array.from(
    new Set(
      Array.from(texts)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  );
  const total = unique.length;
  const result: AnnotateMap = new Map();
  if (total === 0) return result;

  const client = getApiClient();
  const queue = [...unique];
  let done = 0;
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, total),
  );

  async function processOne(text: string): Promise<void> {
    if (opts.signal?.aborted) return;
    try {
      const { data, error } = await client.POST("/annotate", {
        body: {
          text,
          lang_code: opts.langCode,
          phonetic_system: opts.phoneticSystem ?? null,
          opt_in_training: opts.optInTraining ?? false,
        },
        signal: opts.signal,
      });
      if (error) {
        console.warn(
          "[Loom Annotate] /annotate failed for text:",
          text.slice(0, 40),
          error,
        );
        return;
      }
      if (data && Array.isArray(data.spans) && data.spans.length > 0) {
        // We use the structured spans for React rendering — html field
        // is ignored (would need dangerouslySetInnerHTML + scoped CSS
        // for non-ruby modes).
        result.set(text, data.spans as AnnotateSpan[]);
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        // Expected on track-switch / video-nav — silent.
        return;
      }
      console.warn(
        "[Loom Annotate] /annotate threw for text:",
        text.slice(0, 40),
        err.message,
      );
    } finally {
      done += 1;
      opts.onProgress?.(done, total);
    }
  }

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      if (opts.signal?.aborted) return;
      const text = queue.shift();
      if (text === undefined) return;
      await processOne(text);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return result;
}
