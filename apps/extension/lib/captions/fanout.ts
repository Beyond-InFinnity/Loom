// Portable caption fan-out.
//
// Takes a single pot-bearing timedtext URL (captured by background's
// webRequest listener) + a list of tracks, and returns parsed json3
// events per track by lang-swapping the captured URL.
//
// Design intent: KEEP THIS MODULE PURE.  It does not know how the URL
// was acquired and it does not know the destination of the parsed
// events.  This means the same fan-out can later be reused unchanged
// behind a server-side Playwright proof-of-origin acquisition path —
// only the URL-acquisition adapter changes; this layer doesn't.
//
// The load-bearing assumption being verified by the spike: the pot is
// session-bound, not language-bound.  If true, one captured URL is
// sufficient for ALL track languages on the same video.  If false,
// the architecture changes.

import type { CaptionEvent, CaptionTrack } from "./types";

export interface FanoutTrackResult {
  track: CaptionTrack;
  /** Effective URL we fetched (lang/fmt set, all other params preserved). */
  url: string;
  /** HTTP status from the fetch. */
  status: number | null;
  /** Length of the response body (text).  Empty body = 0 = "pot rejection". */
  bodyLength: number;
  /** Parsed events when bodyLength > 0 and JSON parsed.  null otherwise. */
  events: CaptionEvent[] | null;
  /** First event text — quick eyeball that we got real data, not a stub. */
  firstText: string | null;
  /** Error message if anything threw. */
  error: string | null;
  /** Whether this row used tlang= (translation request, not native). */
  isTlang: boolean;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

interface Json3Track {
  wireMagic?: string;
  events?: Json3Event[];
}

export interface FanoutOptions {
  /** Optional BCP-47 code for an auto-translation pass.  When set,
      the request asks YT to machine-translate the source track into
      this language.  Distinct from native multi-lingual tracks. */
  tlang?: string;
  /** Abort signal (e.g. for unmount / nav cancellation). */
  signal?: AbortSignal;
}

/** Lang-swap one track off the captured URL.  Returns a diagnostic
    result that includes empty-body cases as distinct from errors. */
export async function fetchTrackEventsViaSwap(
  capturedUrl: string,
  track: CaptionTrack,
  opts: FanoutOptions = {},
): Promise<FanoutTrackResult> {
  const url = cloneWithLang(capturedUrl, track.languageCode, opts);
  const isTlang = typeof opts.tlang === "string";

  try {
    const response = await fetch(url, { signal: opts.signal });
    const status = response.status;
    if (!response.ok) {
      return {
        track,
        url,
        status,
        bodyLength: 0,
        events: null,
        firstText: null,
        error: `HTTP ${status}`,
        isTlang,
      };
    }
    const text = await response.text();
    if (text.length === 0) {
      // 200 OK with empty body == pot-gate rejected this request (or
      // lang-swap doesn't carry to this track, which is what the spike
      // verifies).  Flag distinctly — don't silently produce empty.
      return {
        track,
        url,
        status,
        bodyLength: 0,
        events: null,
        firstText: null,
        error: "empty response body (pot rejection?)",
        isTlang,
      };
    }
    const data = JSON.parse(text) as Json3Track;
    const events = parseJson3(data.events ?? []);
    return {
      track,
      url,
      status,
      bodyLength: text.length,
      events,
      firstText: events.length > 0 ? events[0].text : null,
      error: null,
      isTlang,
    };
  } catch (e) {
    return {
      track,
      url,
      status: null,
      bodyLength: 0,
      events: null,
      firstText: null,
      error: e instanceof Error ? e.message : String(e),
      isTlang,
    };
  }
}

/** Fan out lang-swap fetches for an entire tracklist + optionally a
    tlang variant of the first manual track.  Returns one result row
    per request.  Use this in the spike + (later) in production
    discovery. */
export async function fanoutTracks(
  capturedUrl: string,
  tracks: CaptionTrack[],
  opts: { tlang?: string; signal?: AbortSignal } = {},
): Promise<FanoutTrackResult[]> {
  const tasks: Promise<FanoutTrackResult>[] = [];
  for (const track of tracks) {
    tasks.push(fetchTrackEventsViaSwap(capturedUrl, track, { signal: opts.signal }));
  }
  // Plus one tlang variant on the first manual track, for spike coverage
  // of the auto-translate path.
  if (opts.tlang) {
    const firstManual = tracks.find((t) => t.kind === "manual") ?? tracks[0];
    if (firstManual) {
      tasks.push(
        fetchTrackEventsViaSwap(capturedUrl, firstManual, {
          tlang: opts.tlang,
          signal: opts.signal,
        }),
      );
    }
  }
  return Promise.all(tasks);
}

/** Clone a captured timedtext URL and swap `lang` (+ optionally
    `tlang`) + force `fmt=json3`.  Preserves pot, c, cver, signature,
    sparams, expire — DO NOT touch those, they're what makes the
    request work. */
export function cloneWithLang(
  capturedUrl: string,
  lang: string,
  opts: { tlang?: string; fmt?: string } = {},
): string {
  const url = new URL(capturedUrl);
  url.searchParams.set("lang", lang);
  url.searchParams.set("fmt", opts.fmt ?? "json3");
  if (opts.tlang) {
    url.searchParams.set("tlang", opts.tlang);
  } else {
    // Remove any inherited tlang from the captured URL so a native
    // request doesn't accidentally translate.
    url.searchParams.delete("tlang");
  }
  return url.toString();
}

/** Pure parser — exposed for testing.  Drops events with no text
    content (paragraph breaks, formatting-only events). */
export function parseJson3(events: Json3Event[]): CaptionEvent[] {
  const result: CaptionEvent[] = [];
  for (const e of events) {
    if (typeof e.tStartMs !== "number") continue;
    const duration = typeof e.dDurationMs === "number" ? e.dDurationMs : 0;
    if (!e.segs || e.segs.length === 0) continue;
    const text = e.segs
      .map((s) => s.utf8 ?? "")
      .join("")
      .trim();
    if (text.length === 0) continue;
    result.push({
      start: e.tStartMs,
      end: e.tStartMs + duration,
      text,
    });
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}
