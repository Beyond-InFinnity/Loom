import { describe, expect, it } from "vitest";
import { placeDefinitionCard, nextCardScale } from "./definition-card";

// A 1080p viewport with the overlay/containing block covering it exactly
// (origin 0,0 → bottom 1080).  Most subtitles sit low, so these mirror the
// real bug scenario (word in the lower half → card placed ABOVE).
const VIEW = { viewportWidth: 1920, viewportHeight: 1080 };
const FULLSCREEN_CB = { left: 0, top: 0, bottom: 1080 };
const W = 300;
const GAP = 10;

const place = (
  word: { left: number; top: number; width: number; height: number },
  container = FULLSCREEN_CB,
) =>
  placeDefinitionCard({
    word: {
      left: word.left,
      right: word.left + word.width,
      top: word.top,
      bottom: word.top + word.height,
      width: word.width,
    },
    container,
    ...VIEW,
    cardWidth: W,
    gap: GAP,
  });

describe("placeDefinitionCard — side selection", () => {
  it("places ABOVE (anchors bottom) for a lower-half word — the subtitle case", () => {
    const p = place({ left: 800, top: 950, width: 60, height: 30 });
    expect(p.bottom).toBeDefined();
    expect(p.top).toBeUndefined();
    // Card bottom sits GAP above the word top: bottom offset = cbBottom - (wordTop - gap).
    expect(p.bottom).toBe(1080 - (950 - GAP)); // 140
  });

  it("places BELOW (anchors top) for an upper-half word", () => {
    const p = place({ left: 800, top: 80, width: 60, height: 30 });
    expect(p.top).toBeDefined();
    expect(p.bottom).toBeUndefined();
    // Card top sits GAP below the word bottom (110): top offset = wordBottom + gap - cbTop.
    expect(p.top).toBe(80 + 30 + GAP); // 120
  });
});

describe("placeDefinitionCard — height independence (no bounce)", () => {
  it("returns the SAME position regardless of the card's content/height", () => {
    // The function takes no card-height input at all, so a loading skeleton and
    // a fully-loaded card at the same word rect are identical by construction.
    const loading = place({ left: 800, top: 950, width: 60, height: 30 });
    const loaded = place({ left: 800, top: 950, width: 60, height: 30 });
    expect(loaded).toEqual(loading);
  });

  it("horizontal centering does not depend on width growth (fixed cardWidth)", () => {
    const p = place({ left: 800, top: 950, width: 60, height: 30 });
    // centerX = 830; left offset = clamp(830 - 150) = 680, minus cbLeft(0).
    expect(p.left).toBe(680);
  });
});

describe("placeDefinitionCard — on-screen clamping", () => {
  it("clamps a right-edge word so the card never runs off the right", () => {
    const p = place({ left: 1890, top: 950, width: 20, height: 30 });
    // centerX = 1900; unclamped left = 1750; max = vw - W - margin = 1612.
    expect(p.left).toBe(1612);
  });

  it("clamps a left-edge word to the margin", () => {
    const p = place({ left: 0, top: 950, width: 20, height: 30 });
    // centerX = 10; unclamped left = -140; clamped to margin 8.
    expect(p.left).toBe(8);
  });

  it("caps maxHeight to the room on the chosen side and the hard fraction", () => {
    // Lower-half word: room above is large, so the hard 0.6*vh cap wins.
    const p = place({ left: 800, top: 950, width: 60, height: 30 });
    expect(p.maxHeight).toBe(Math.round(1080 * 0.6)); // 648
    // A word only just past mid-screen leaves less room above → room-capped.
    const tight = place({ left: 800, top: 560, width: 60, height: 30 });
    expect(tight.maxHeight).toBe(560 - GAP - 8); // roomAbove = 542
  });
});

describe("placeDefinitionCard — offset containing block (windowed player)", () => {
  it("subtracts the container origin so coords are containing-block-relative", () => {
    // Player windowed at viewport (100, 50), 1000 tall → bottom 1050.
    const cb = { left: 100, top: 50, bottom: 1050 };
    const p = place({ left: 800, top: 950, width: 60, height: 30 }, cb);
    expect(p.left).toBe(680 - 100); // vpLeft 680 minus cbLeft 100
    expect(p.bottom).toBe(1050 - (950 - GAP)); // cbBottom - (wordTop - gap)
  });
});

describe("nextCardScale — uniform resize from a grip drag", () => {
  const BW = 300; // CARD_WIDTH

  it("grows proportionally when dragging the bottom grip outward", () => {
    const s = nextCardScale({ startScale: 1, dx: 150, dy: 150, signX: 1, signY: 1, baseWidth: BW });
    expect(s).toBeCloseTo(1.5, 5);
  });

  it("grows for the TOP grip when dragging UP (signY -1)", () => {
    const s = nextCardScale({ startScale: 1, dx: 150, dy: -150, signX: 1, signY: -1, baseWidth: BW });
    expect(s).toBeCloseTo(1.5, 5);
  });

  it("shrinks when dragging inward", () => {
    const s = nextCardScale({ startScale: 1.5, dx: -150, dy: -150, signX: 1, signY: 1, baseWidth: BW });
    expect(s).toBeCloseTo(1.0, 5);
  });

  it("clamps at the max", () => {
    const s = nextCardScale({ startScale: 3, dx: 600, dy: 600, signX: 1, signY: 1, baseWidth: BW });
    expect(s).toBe(3.5);
  });

  it("clamps at the min", () => {
    const s = nextCardScale({ startScale: 1, dx: -600, dy: -600, signX: 1, signY: 1, baseWidth: BW });
    expect(s).toBe(0.85);
  });

  it("is a no-op with no movement (aspect held by a single scalar)", () => {
    const s = nextCardScale({ startScale: 1.7, dx: 0, dy: 0, signX: 1, signY: 1, baseWidth: BW });
    expect(s).toBeCloseTo(1.7, 5);
  });
});

describe("nextCardScale — viewport-fit cap", () => {
  it("caps at the provided maxScale (narrow player)", () => {
    const s = nextCardScale({ startScale: 1, dx: 600, dy: 600, signX: 1, signY: 1, baseWidth: 300, maxScale: 1.5 });
    expect(s).toBe(1.5);
  });
  it("never exceeds SCALE_MAX even if maxScale is larger", () => {
    const s = nextCardScale({ startScale: 3, dx: 600, dy: 600, signX: 1, signY: 1, baseWidth: 300, maxScale: 5 });
    expect(s).toBe(3.5);
  });
});
