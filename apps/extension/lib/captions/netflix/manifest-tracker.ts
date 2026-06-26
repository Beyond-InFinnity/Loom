// Netflix manifest → "which title is actually playing" state machine.
//
// Extracted from netflix-main.content.ts as a PURE reducer so the
// load-bearing prefetch-vs-advance logic is unit-testable (the rest of
// the MAIN-world script is DOM/event-driven and verified live).  No
// side effects here — the caller (netflix-main) does the postMessage +
// logging based on the returned Action.
//
// THE PROBLEM this solves (2026-06): near the end of an episode Netflix
// prefetches the NEXT episode's manifest to buffer ahead, AND moves the
// page URL to the next /watch/<id> (or briefly blanks it) — all while the
// <video> is still playing the current episode's credits.  So neither "a
// new manifest arrived" nor "movieId matches the URL" tells us the
// episode actually changed.  The only reliable signal is the MEDIA
// ELEMENT swapping streams (loadstart/emptied).
//
// So: a manifest for a DIFFERENT title than the one playing is HELD
// (`pending`), not adopted, until a media swap confirms the player really
// moved on.  A manifest is always parsed before its media loadstart (the
// player needs it to load the stream), so by the time a swap fires,
// `pending` already holds the episode that is now playing.

/** Generic over the opaque payload the caller carries through (the
    tracklist it will postMessage).  The tracker only inspects movieId +
    status; the payload rides along untouched. */
export interface TrackerState<P> {
  /** The title we're currently displaying tracks for (committed). */
  activeMovieId: string | null;
  /** Did we commit an "ok" (WebVTT) tracklist for it?  An image-only
      title commits "no-captions"; a later capture can upgrade it to ok,
      and we only want to re-post on that upgrade — not on every dup. */
  activeIsOk: boolean;
  /** A DIFFERENT title's tracklist, parsed (prefetch) but not yet
      adopted — flushed on the next media swap. */
  pending: { movieId: string; status: TrackStatus; payload: P } | null;
}

export type TrackStatus = "ok" | "no-captions";

/** What the caller should do with this transition. */
export type TrackerAction<P> =
  /** Post this tracklist to ISO now. */
  | { kind: "post"; payload: P }
  /** A different title was held as pending (caller logs; posts nothing). */
  | { kind: "hold"; movieId: string }
  /** Dup / nothing to do. */
  | { kind: "ignore" };

export function initialTrackerState<P>(): TrackerState<P> {
  return { activeMovieId: null, activeIsOk: false, pending: null };
}

/** A manifest was parsed.  Decide whether to adopt it (post), hold it
    (prefetch of a different title), or ignore it (dup of the current). */
export function reduceManifest<P>(
  state: TrackerState<P>,
  ev: { movieId: string; status: TrackStatus; payload: P },
): { state: TrackerState<P>; action: TrackerAction<P> } {
  const { movieId, status, payload } = ev;

  // First title we've ever seen → adopt immediately (its media loadstart
  // likely fired before our hooks installed, so we can't wait for one).
  if (state.activeMovieId === null) {
    return {
      state: { activeMovieId: movieId, activeIsOk: status === "ok", pending: null },
      action: { kind: "post", payload },
    };
  }

  // Re-parse of the title we're already displaying.  Netflix parses a
  // manifest several times per playback; skip dups — but DO re-post if a
  // later capture upgraded an image-only title to WebVTT (the profile
  // injection sometimes only takes on a subsequent fetch).
  if (movieId === state.activeMovieId) {
    if (status === "ok" && !state.activeIsOk) {
      return {
        state: { ...state, activeIsOk: true },
        action: { kind: "post", payload },
      };
    }
    return { state, action: { kind: "ignore" } };
  }

  // A DIFFERENT title than the one playing → the prefetch trap.  Hold it;
  // a media swap adopts it later.  We keep only the LATEST held title:
  // Netflix prefetches the immediate-next episode only, so a second
  // distinct title arriving before any swap is not expected — if that
  // assumption ever breaks, the most-recently-parsed title wins (and the
  // diagnostic log in netflix-main would show the churn).
  return {
    state: { ...state, pending: { movieId, status, payload } },
    action: { kind: "hold", movieId },
  };
}

/** The ISO overlay reported a watch-URL change to `videoId` (autoplay or
    manual advance).  On Netflix this is the RELIABLE episode-swap signal:
    playback is MSE (the <video> element is reused and fed via SourceBuffer),
    so episode changes fire NO loadstart/emptied — reduceMediaSwap can't see
    them.  The URL change can, so we adopt the held manifest for the new id.
    - pending matches the new id → adopt it (its manifest was prefetched).
    - already active → no-op (duplicate / query-only change).
    - neither → reset to "no active title" so the next manifest matching the
      new /watch/ URL adopts via reduceManifest's first-title path. */
export function reduceWatchChange<P>(
  state: TrackerState<P>,
  videoId: string,
): { state: TrackerState<P>; action: TrackerAction<P> } {
  if (state.pending && state.pending.movieId === videoId) {
    const { movieId, status, payload } = state.pending;
    return {
      state: { activeMovieId: movieId, activeIsOk: status === "ok", pending: null },
      action: { kind: "post", payload },
    };
  }
  if (state.activeMovieId === videoId) {
    return { state, action: { kind: "ignore" } };
  }
  return {
    state: { activeMovieId: null, activeIsOk: false, pending: null },
    action: { kind: "ignore" },
  };
}

/** The <video> swapped streams (loadstart/emptied) — the episode really
    changed.  Adopt whatever title we were holding. */
export function reduceMediaSwap<P>(
  state: TrackerState<P>,
): { state: TrackerState<P>; action: TrackerAction<P> } {
  if (!state.pending) {
    return { state, action: { kind: "ignore" } };
  }
  const { movieId, status, payload } = state.pending;
  return {
    state: { activeMovieId: movieId, activeIsOk: status === "ok", pending: null },
    action: { kind: "post", payload },
  };
}
