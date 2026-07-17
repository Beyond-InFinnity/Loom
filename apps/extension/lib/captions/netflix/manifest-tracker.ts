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
// <video> is still playing the current episode's credits.  So "a new
// manifest arrived" alone can't mean the episode changed.
//
// THE SECOND PROBLEM (2026-07, the F5-only bug): Netflix also parses a
// title's manifest BEFORE history.pushState flips the URL to its
// /watch/<id> — on a browse→episode SPA click the manifest can be the
// FIRST signal, arriving while the URL still says /browse.  The old
// design DROPPED such manifests (they matched neither the active title
// nor the URL), and Netflix never re-parses → no tracklist until F5.
//
// So: every manifest is HELD in a small bounded map keyed by movieId —
// never dropped.  Adoption (posting a held tracklist as the active
// title) happens only on an explicit signal that names WHICH title:
//   - reduceWatchChange(videoId)  — the URL moved to /watch/<videoId>
//   - reduceMediaSwap(urlMovieId) — the <video> swapped streams while
//     the URL names a (different) title
//   - reduceManifest(…, urlMovieId) — a manifest matching the CURRENT
//     /watch/ URL arrives while nothing is active (fresh page load)
// Home-preview / detail-page manifests are held too, harmlessly: they
// are only ever adopted if the URL actually navigates to their title —
// in which case adopting them is correct.

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
  /** True when the active tracklist was adopted FROM THE HELD MAP
      (watch-changed / media-swap / request adoption) rather than from a
      just-parsed manifest.  A held payload can be minutes-to-hours old,
      and its signed WebVTT URLs expire (~12 h TTL) — so after a held
      adoption, the FIRST fresh "ok" re-parse of the title re-posts
      (refreshing the URLs) instead of being dup-ignored.  Cleared by
      that refresh; subsequent dup parses ignore as usual. */
  activeFromHeld: boolean;
  /** Recently parsed tracklists by movieId — insertion-ordered, bounded
      at HELD_MAX, a re-parse refreshes its entry (newest signed URLs
      win; an "ok" entry is never downgraded by a partial "no-captions"
      re-parse).  Includes prefetches, previews, and pre-watch manifests.
      Entries stay after adoption so a bounce-away-and-back re-adopts. */
  held: ReadonlyArray<HeldEntry<P>>;
}

export interface HeldEntry<P> {
  movieId: string;
  status: TrackStatus;
  payload: P;
}

export type TrackStatus = "ok" | "no-captions";

/** Titles retained in the held map.  Browse sessions parse a manifest
    per hovered preview; 8 comfortably covers a browse trail while
    bounding memory (a payload is ~12 serialized tracks). */
const HELD_MAX = 8;

/** What the caller should do with this transition. */
export type TrackerAction<P> =
  /** Post this tracklist to ISO now. */
  | { kind: "post"; payload: P }
  /** The title was held for a later adoption signal (caller logs). */
  | { kind: "hold"; movieId: string }
  /** Dup / nothing to do. */
  | { kind: "ignore" };

export function initialTrackerState<P>(): TrackerState<P> {
  return { activeMovieId: null, activeIsOk: false, activeFromHeld: false, held: [] };
}

/** held with `entry` upserted: same-id entry replaced in place-ish
    (moved to the end = most recent), oldest evicted past HELD_MAX.
    Never DOWNGRADES: a partial "no-captions" re-parse of a title whose
    held entry is already "ok" keeps the ok entry (just refreshed to
    most-recent) — else a bounce-back adoption could serve an image-only
    tracklist for a title known to have WebVTT. */
function upsertHeld<P>(
  held: ReadonlyArray<HeldEntry<P>>,
  entry: HeldEntry<P>,
): ReadonlyArray<HeldEntry<P>> {
  const prev = held.find((h) => h.movieId === entry.movieId);
  const keep =
    prev && prev.status === "ok" && entry.status === "no-captions"
      ? prev
      : entry;
  const rest = held.filter((h) => h.movieId !== entry.movieId);
  const next = [...rest, keep];
  return next.length > HELD_MAX ? next.slice(next.length - HELD_MAX) : next;
}

function findHeld<P>(
  held: ReadonlyArray<HeldEntry<P>>,
  movieId: string,
): HeldEntry<P> | undefined {
  return held.find((h) => h.movieId === movieId);
}

/** A manifest was parsed.  Always retained in `held`; additionally
    adopted (post) when it IS the current title — the active one
    upgrading to WebVTT, or the title the /watch/ URL names while
    nothing is active yet (fresh page load / post-reset). */
export function reduceManifest<P>(
  state: TrackerState<P>,
  ev: { movieId: string; status: TrackStatus; payload: P },
  urlMovieId: string | null,
): { state: TrackerState<P>; action: TrackerAction<P> } {
  const { movieId, status, payload } = ev;
  const held = upsertHeld(state.held, { movieId, status, payload });

  // Re-parse of the title we're already displaying.  Netflix parses a
  // manifest several times per playback; skip dups — but DO re-post when
  // (a) a later capture upgraded an image-only title to WebVTT (the
  // profile injection sometimes only takes on a subsequent fetch), or
  // (b) the active tracklist was adopted from the HELD map (possibly
  // aged signed URLs) and this is the first fresh parse since — the
  // refresh carries current URLs, so an expired-URL 403 self-heals.
  if (movieId === state.activeMovieId) {
    if (status === "ok" && (!state.activeIsOk || state.activeFromHeld)) {
      return {
        state: { ...state, activeIsOk: true, activeFromHeld: false, held },
        action: { kind: "post", payload },
      };
    }
    return { state: { ...state, held }, action: { kind: "ignore" } };
  }

  // Nothing active AND this manifest is the title the /watch/ URL names
  // → adopt immediately (fresh page load; its media loadstart likely
  // fired before our hooks installed, so we can't wait for one).
  if (state.activeMovieId === null && urlMovieId !== null && movieId === urlMovieId) {
    return {
      state: {
        activeMovieId: movieId,
        activeIsOk: status === "ok",
        activeFromHeld: false,
        held,
      },
      action: { kind: "post", payload },
    };
  }

  // Any other title — a next-episode prefetch while one is active (the
  // Frieren trap), a home-preview, or a pre-watch parse of the title
  // being navigated to.  HELD, never dropped: reduceWatchChange /
  // reduceMediaSwap adopt it when a signal names it.
  return {
    state: { ...state, held },
    action: { kind: "hold", movieId },
  };
}

/** The ISO overlay reported the URL moved to /watch/<videoId> (SPA nav,
    autoplay, or manual advance).  On Netflix this is the RELIABLE
    episode signal: playback is MSE (the <video> element is reused and
    fed via SourceBuffer), so episode changes fire NO loadstart/emptied.
    - held has this title → adopt it (parsed as a prefetch OR pre-watch).
    - already active → no-op (duplicate / query-only change).
    - never seen → reset to "no active title" so the next manifest
      matching the new /watch/ URL adopts via reduceManifest. */
export function reduceWatchChange<P>(
  state: TrackerState<P>,
  videoId: string,
): { state: TrackerState<P>; action: TrackerAction<P> } {
  if (state.activeMovieId === videoId) {
    return { state, action: { kind: "ignore" } };
  }
  const entry = findHeld(state.held, videoId);
  if (entry) {
    return {
      state: {
        activeMovieId: entry.movieId,
        activeIsOk: entry.status === "ok",
        activeFromHeld: true,
        held: state.held,
      },
      action: { kind: "post", payload: entry.payload },
    };
  }
  return {
    state: {
      activeMovieId: null,
      activeIsOk: false,
      activeFromHeld: false,
      held: state.held,
    },
    action: { kind: "ignore" },
  };
}

/** The <video> swapped streams (loadstart/emptied).  Adopt the held
    manifest for the title the URL CURRENTLY names — the swap says the
    stream changed NOW, the URL says to WHAT.  URL-anchored so the
    browse page's preview `<video>` loadstarts (urlMovieId null there)
    can never adopt anything — the pollution path the old "adopt
    whatever was pending" semantics allowed. */
export function reduceMediaSwap<P>(
  state: TrackerState<P>,
  urlMovieId: string | null,
): { state: TrackerState<P>; action: TrackerAction<P> } {
  if (urlMovieId === null || urlMovieId === state.activeMovieId) {
    return { state, action: { kind: "ignore" } };
  }
  const entry = findHeld(state.held, urlMovieId);
  if (!entry) {
    return { state, action: { kind: "ignore" } };
  }
  return {
    state: {
      activeMovieId: entry.movieId,
      activeIsOk: entry.status === "ok",
      activeFromHeld: true,
      held: state.held,
    },
    action: { kind: "post", payload: entry.payload },
  };
}

/** The URL left /watch/ entirely (back to browse / a detail page).
    Clear the committed title — while browsing, NOTHING is playing, and
    a stale `active` is what let the previous title's tracklist keep
    serving (and its cached re-emit keep answering) on the next episode.
    Held manifests are retained: bouncing back into a title re-adopts
    instantly via reduceWatchChange. */
export function reduceWatchLeft<P>(state: TrackerState<P>): TrackerState<P> {
  return {
    activeMovieId: null,
    activeIsOk: false,
    activeFromHeld: false,
    held: state.held,
  };
}
