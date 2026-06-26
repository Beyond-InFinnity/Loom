import { describe, expect, it } from "vitest";
import {
  initialTrackerState,
  reduceManifest,
  reduceMediaSwap,
  reduceWatchChange,
  type TrackStatus,
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

describe("manifest-tracker — first load", () => {
  it("adopts the first title immediately (post + becomes active)", () => {
    const { state, action } = reduceManifest(initialTrackerState<P>(), ev("A"));
    expect(action).toEqual({ kind: "post", payload: { id: "A" } });
    expect(state.activeMovieId).toBe("A");
    expect(state.activeIsOk).toBe(true);
    expect(state.pending).toBeNull();
  });

  it("first title image-only commits as no-captions (activeIsOk false)", () => {
    const { state, action } = reduceManifest(
      initialTrackerState<P>(),
      ev("A", "no-captions"),
    );
    expect(action.kind).toBe("post");
    expect(state.activeMovieId).toBe("A");
    expect(state.activeIsOk).toBe(false);
  });
});

describe("manifest-tracker — re-parse of the current title", () => {
  it("ignores a duplicate ok re-parse", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A")).state;
    const { state, action } = reduceManifest(s, ev("A"));
    expect(action).toEqual({ kind: "ignore" });
    expect(state).toBe(s); // unchanged
  });

  it("re-posts when an image-only title upgrades to WebVTT", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A", "no-captions")).state;
    expect(s.activeIsOk).toBe(false);
    const { state, action } = reduceManifest(s, ev("A", "ok"));
    expect(action).toEqual({ kind: "post", payload: { id: "A" } });
    expect(state.activeIsOk).toBe(true);
  });

  it("does NOT re-post a second ok after the upgrade", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A", "no-captions")).state;
    s = reduceManifest(s, ev("A", "ok")).state;
    const { action } = reduceManifest(s, ev("A", "ok"));
    expect(action.kind).toBe("ignore");
  });
});

describe("manifest-tracker — the prefetch trap (Frieren)", () => {
  it("HOLDS a different title instead of posting it", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A")).state; // watching A
    const { state, action } = reduceManifest(s, ev("B")); // prefetch of B
    expect(action).toEqual({ kind: "hold", movieId: "B" });
    expect(state.activeMovieId).toBe("A"); // still showing A
    expect(state.pending?.movieId).toBe("B");
  });

  it("does not switch on the held title until a media swap", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A")).state;
    s = reduceManifest(s, ev("B")).state; // held
    // No swap yet → active stays A; the overlay keeps A's tracks.
    expect(s.activeMovieId).toBe("A");
    // Media swap fires → adopt B.
    const { state, action } = reduceMediaSwap(s);
    expect(action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(state.activeMovieId).toBe("B");
    expect(state.pending).toBeNull();
  });

  it("full sequence: A active → B prefetch held → swap adopts B", () => {
    let s = initialTrackerState<P>();
    let a = reduceManifest(s, ev("A"));
    s = a.state;
    expect(a.action.kind).toBe("post");

    a = reduceManifest(s, ev("B"));
    s = a.state;
    expect(a.action.kind).toBe("hold");

    const swap = reduceMediaSwap(s);
    expect(swap.action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(swap.state.activeMovieId).toBe("B");
  });
});

describe("manifest-tracker — media swap with nothing held", () => {
  it("ignores a swap when there is no pending title", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A")).state;
    const { state, action } = reduceMediaSwap(s);
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBe("A");
  });
});

describe("manifest-tracker — image-only next episode", () => {
  it("adopts a no-captions next episode on swap (overlay degrades)", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A")).state; // A ok
    s = reduceManifest(s, ev("B", "no-captions")).state; // B prefetch, image-only
    const { state, action } = reduceMediaSwap(s);
    expect(action.kind).toBe("post");
    expect(state.activeMovieId).toBe("B");
    expect(state.activeIsOk).toBe(false);
  });
});

describe("manifest-tracker — watch-change (URL-driven swap, MSE)", () => {
  it("adopts the held next episode when the URL changes to it", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A")).state; // A active
    s = reduceManifest(s, ev("B")).state; // B prefetched + held
    const { state, action } = reduceWatchChange(s, "B");
    expect(action).toEqual({ kind: "post", payload: { id: "B" } });
    expect(state.activeMovieId).toBe("B");
    expect(state.pending).toBeNull();
  });

  it("no-ops when the URL change is to the already-active title", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A")).state;
    const { state, action } = reduceWatchChange(s, "A");
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBe("A");
  });

  it("resets active for an un-prefetched title so its next manifest adopts", () => {
    const s = reduceManifest(initialTrackerState<P>(), ev("A")).state;
    const { state, action } = reduceWatchChange(s, "Z"); // never seen
    expect(action).toEqual({ kind: "ignore" });
    expect(state.activeMovieId).toBeNull();
    // Next manifest for Z (gated to the /watch/ URL in netflix-main) adopts.
    const next = reduceManifest(state, ev("Z"));
    expect(next.action).toEqual({ kind: "post", payload: { id: "Z" } });
    expect(next.state.activeMovieId).toBe("Z");
  });
});

describe("manifest-tracker — latest held title wins", () => {
  it("a second distinct prefetch overwrites the first held title", () => {
    let s = reduceManifest(initialTrackerState<P>(), ev("A")).state;
    s = reduceManifest(s, ev("B")).state;
    s = reduceManifest(s, ev("C")).state; // (not expected from Netflix, but defined)
    expect(s.pending?.movieId).toBe("C");
    const { state } = reduceMediaSwap(s);
    expect(state.activeMovieId).toBe("C");
  });
});
