import { describe, expect, it } from "vitest";
import {
  initialTrackerState,
  reduceManifest,
  reduceMediaSwap,
  reduceWatchChange,
  reduceWatchLeft,
  type TrackStatus,
  type TrackerState,
} from "./manifest-tracker";

// The opaque payload is just tagged with its movieId here so assertions
// can confirm WHICH title's payload was posted.
interface P {
  id: string;
}
const ev = (movieId: string, status: TrackStatus = "ok") => ({
  movieId,
  status,
  payload: { id: movieId } as P,
});

const heldIds = (s: TrackerState<P>) => s.held.map((h) => h.movieId);

describe("manifest-tracker — first load (URL already on the title)", () => {
  it("adopts the manifest matching the /watch/ URL (post + becomes active)", () => {
    const { state, action } = reduceManifest(
      initialTrackerState<P>(),
      ev("A"),
      "A",
    );
    expect(action).toEqual({ kind: "post", payload: { id: "A" } });
    expect(state.activeMovieId).toBe("A");
    expect(state.activeIsOk).toBe(true);
  });

  it("first title image-only commits as no-captions (activeIsOk false)", () => {
    const { state, action } = reduceManifest(
      initialTrackerState<P>(),
      ev("A", "no-captions"),
      "A",
    );
    expect(action.kind).toBe("post");
    expect(state.activeMovieId).toBe("A");
    expect(state.activeIsOk).toBe(false);
  });
});

describe("manifest-tracker — pre-watch manifest (the F5-only bug)", () => {
  it("HOLDS a manifest that parses before the URL flips (browse click)", () => {
    // Netflix parses B's manifest while location is still /browse.
    const { state, action } = reduceManifest(
      initialTrackerState<P>(),
      ev("B"),
      null, // not on a /watch/ URL yet
    );
    expect(action).toEqual({ kind: "hold", movieId: "B" });
    expect(state.activeMovieId).toBeNull();
    expect(heldIds(state)).toEqual(["B"]);
  });

  it("watch-changed then ADOPTS the held pre-watch manifest", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("B"), null).state;
    // URL flips to /watch/B (WXT locationchange, ≤1s later).
    const { state, action } = reduceWatchChange(s, "B");
    expect(action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(state.activeMovieId).toBe("B");
  });

  it("holds when nothing is active and the URL names a DIFFERENT title", () => {
    // Gate-drop variant 1b: on /watch/<X> while the manifest is <B>.
    const { state, action } = reduceManifest(
      initialTrackerState<P>(),
      ev("B"),
      "X",
    );
    expect(action).toEqual({ kind: "hold", movieId: "B" });
    expect(state.activeMovieId).toBeNull();
    // …and if the URL later moves to B, it adopts.
    const next = reduceWatchChange(state, "B");
    expect(next.action.kind).toBe("post");
  });

  it("home-preview manifests are held but never adopted without a URL naming them", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("preview1"), null).state;
    expect(s.activeMovieId).toBeNull();
    // A browse-preview <video> loadstart fires — URL still has no /watch/ id.
    const swap = reduceMediaSwap(s, null);
    expect(swap.action).toEqual({ kind: "ignore" });
    expect(swap.state.activeMovieId).toBeNull();
  });
});

describe("manifest-tracker — re-parse of the current title", () => {
  it("ignores a duplicate ok re-parse", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    const { state, action } = reduceManifest(s, ev("A"), "A");
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBe("A");
  });

  it("re-posts when an image-only title upgrades to WebVTT", () => {
    const s = reduceManifest(
      initialTrackerState<P>(),
      ev("A", "no-captions"),
      "A",
    ).state;
    expect(s.activeIsOk).toBe(false);
    const { state, action } = reduceManifest(s, ev("A", "ok"), "A");
    expect(action).toEqual({ kind: "post", payload: { id: "A" } });
    expect(state.activeIsOk).toBe(true);
  });

  it("does NOT re-post a second ok after the upgrade", () => {
    let s = reduceManifest(
      initialTrackerState<P>(),
      ev("A", "no-captions"),
      "A",
    ).state;
    s = reduceManifest(s, ev("A", "ok"), "A").state;
    const { action } = reduceManifest(s, ev("A", "ok"), "A");
    expect(action.kind).toBe("ignore");
  });

  it("a re-parse refreshes the held entry (newest signed URLs win)", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    const refreshed = { movieId: "A", status: "ok" as const, payload: { id: "A-v2" } };
    s = reduceManifest(s, refreshed, "A").state;
    // Bounce away and back: the re-adoption serves the REFRESHED payload.
    s = reduceWatchLeft(s);
    const back = reduceWatchChange(s, "A");
    expect(back.action).toEqual({ kind: "post", payload: { id: "A-v2" } });
  });
});

describe("manifest-tracker — the prefetch trap (Frieren)", () => {
  it("HOLDS a different title instead of posting it (URL still on A)", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    const { state, action } = reduceManifest(s, ev("B"), "A"); // prefetch of B
    expect(action).toEqual({ kind: "hold", movieId: "B" });
    expect(state.activeMovieId).toBe("A"); // still showing A
    expect(heldIds(state)).toContain("B");
  });

  it("does not switch until a signal names B; a media swap with the URL on B adopts", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceManifest(s, ev("B"), "A").state; // held
    expect(s.activeMovieId).toBe("A");
    // Netflix moves the URL to /watch/B, then the stream swaps.
    const { state, action } = reduceMediaSwap(s, "B");
    expect(action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(state.activeMovieId).toBe("B");
  });

  it("a media swap while the URL still names the ACTIVE title is a no-op", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceManifest(s, ev("B"), "A").state; // B held
    const { state, action } = reduceMediaSwap(s, "A"); // URL didn't move
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBe("A");
  });
});

describe("manifest-tracker — watch-change (URL-driven swap, MSE)", () => {
  it("adopts the held next episode when the URL changes to it", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceManifest(s, ev("B"), "A").state; // B prefetched + held
    const { state, action } = reduceWatchChange(s, "B");
    expect(action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(state.activeMovieId).toBe("B");
  });

  it("no-ops when the URL change is to the already-active title", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    const { state, action } = reduceWatchChange(s, "A");
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBe("A");
  });

  it("resets active for a never-parsed title so its next manifest adopts", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    const { state, action } = reduceWatchChange(s, "Z"); // never seen
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBeNull();
    // Z's manifest then arrives with the URL already on Z → adopts.
    const next = reduceManifest(state, ev("Z"), "Z");
    expect(next.action).toEqual({ kind: "post", payload: { id: "Z" } });
    expect(next.state.activeMovieId).toBe("Z");
  });

  it("an intervening preview parse does NOT clobber the held next episode", () => {
    // Bug-2 leg (i): B held, then a preview parses before watch-changed(B).
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceManifest(s, ev("B"), "A").state; // next episode held
    s = reduceManifest(s, ev("preview7"), "A").state; // browse-preview churn
    const { state, action } = reduceWatchChange(s, "B");
    expect(action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(state.activeMovieId).toBe("B");
  });
});

describe("manifest-tracker — watch-left (back button → browse)", () => {
  it("clears active but keeps held titles", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceWatchLeft(s);
    expect(s.activeMovieId).toBeNull();
    expect(s.activeIsOk).toBe(false);
    expect(heldIds(s)).toContain("A");
  });

  it("full back-nav sequence: A active → back → browse previews → open C", () => {
    // The bug-2 repro, end to end.
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceWatchLeft(s); // back button
    s = reduceManifest(s, ev("p1"), null).state; // browse previews
    s = reduceManifest(s, ev("p2"), null).state;
    // Preview <video> loadstarts on browse never adopt (no /watch/ URL).
    expect(reduceMediaSwap(s, null).action).toEqual({ kind: "ignore" });
    // C's manifest parses BEFORE the URL flips (the pre-watch parse)…
    s = reduceManifest(s, ev("C"), null).state;
    expect(s.activeMovieId).toBeNull(); // nothing adopted while browsing
    // …then the URL lands on /watch/C → adopt C, not A, not a preview.
    const { state, action } = reduceWatchChange(s, "C");
    expect(action).toEqual({ kind: "post", payload: { id: "C" } });
    expect(state.activeMovieId).toBe("C");
  });

  it("re-entering the SAME title after backing out re-adopts it", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceWatchLeft(s);
    const { state, action } = reduceWatchChange(s, "A");
    expect(action).toEqual({ kind: "post", payload: { id: "A" } });
    expect(state.activeMovieId).toBe("A");
  });
});

describe("manifest-tracker — held map bounds", () => {
  it("evicts the oldest entry past the cap, keeping the newest", () => {
    let s = initialTrackerState<P>();
    for (let i = 0; i < 10; i++) {
      s = reduceManifest(s, ev(`t${i}`), null).state;
    }
    expect(s.held.length).toBeLessThanOrEqual(8);
    expect(heldIds(s)).toContain("t9"); // newest retained
    expect(heldIds(s)).not.toContain("t0"); // oldest evicted
  });

  it("upserting an existing title refreshes it without growing the map", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), null).state;
    s = reduceManifest(s, ev("B"), null).state;
    s = reduceManifest(s, ev("A"), null).state; // re-parse of A
    expect(heldIds(s)).toEqual(["B", "A"]); // A moved to most-recent
  });
});

describe("manifest-tracker — held-adoption URL refresh (aged signed URLs)", () => {
  it("first ok re-parse AFTER a held adoption re-posts (fresh URLs); later dups ignore", () => {
    // Adopt from held (payload may be minutes/hours old → URLs near TTL).
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), null).state; // pre-watch hold
    let r = reduceWatchChange(s, "A"); // held adoption
    s = r.state;
    expect(r.action.kind).toBe("post");
    // Netflix re-parses the manifest on actually entering the title —
    // fresh signed URLs.  This ONE re-parse must re-post…
    const fresh = { movieId: "A", status: "ok" as const, payload: { id: "A-fresh" } };
    const refresh = reduceManifest(s, fresh, "A");
    expect(refresh.action).toEqual({ kind: "post", payload: { id: "A-fresh" } });
    // …and subsequent dup parses go back to being ignored.
    const dup = reduceManifest(refresh.state, ev("A"), "A");
    expect(dup.action.kind).toBe("ignore");
  });

  it("a manifest-path adoption (URL match) does NOT trigger the refresh re-post", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state; // fresh adopt
    const { action } = reduceManifest(s, ev("A"), "A");
    expect(action.kind).toBe("ignore"); // just-parsed URLs — no refresh needed
  });
});

describe("manifest-tracker — held entry never downgraded", () => {
  it("a partial no-captions re-parse keeps the held ok entry's payload", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("B"), null).state; // ok held
    const partial = {
      movieId: "B",
      status: "no-captions" as const,
      payload: { id: "B-imageonly" },
    };
    s = reduceManifest(s, partial, null).state; // partial parse must not clobber
    const { state, action } = reduceWatchChange(s, "B");
    expect(action).toEqual({ kind: "post", payload: { id: "B" } }); // the ok payload
    expect(state.activeIsOk).toBe(true);
  });
});

describe("manifest-tracker — image-only next episode", () => {
  it("adopts a no-captions next episode on watch-change (overlay degrades)", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A"), "A").state;
    s = reduceManifest(s, ev("B", "no-captions"), "A").state;
    const { state, action } = reduceWatchChange(s, "B");
    expect(action.kind).toBe("post");
    expect(state.activeMovieId).toBe("B");
    expect(state.activeIsOk).toBe(false);
  });
});
