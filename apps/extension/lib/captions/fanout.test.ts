import { describe, expect, it } from "vitest";

import { cloneWithLang, parseJson3 } from "./fanout";

// A captured pot-bearing timedtext URL that happens to carry kind=asr (i.e.
// YouTube prefetched an auto-generated track). The swap must clear/set kind
// per the TARGET track, not inherit this.
const CAPTURED =
  "https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=srv3&pot=POTTOKEN&c=WEB&kind=asr&xoaf=5";

describe("cloneWithLang — kind=asr handling (regression: ASR Japanese showed no subs)", () => {
  it("sets kind=asr when the target track is auto-generated", () => {
    const out = new URL(cloneWithLang(CAPTURED, "ja", { kind: "asr" }));
    expect(out.searchParams.get("lang")).toBe("ja");
    expect(out.searchParams.get("kind")).toBe("asr");
    expect(out.searchParams.get("fmt")).toBe("json3");
  });

  it("clears an inherited kind=asr when the target track is manual", () => {
    const out = new URL(cloneWithLang(CAPTURED, "ja", { kind: "manual" }));
    expect(out.searchParams.get("kind")).toBeNull();
    expect(out.searchParams.get("lang")).toBe("ja");
  });

  it("clears kind when none is specified (defaults to manual)", () => {
    const out = new URL(cloneWithLang(CAPTURED, "en"));
    expect(out.searchParams.get("kind")).toBeNull();
  });

  it("preserves the pot token + session params across the swap", () => {
    const out = new URL(cloneWithLang(CAPTURED, "ja", { kind: "asr" }));
    expect(out.searchParams.get("pot")).toBe("POTTOKEN");
    expect(out.searchParams.get("c")).toBe("WEB");
    expect(out.searchParams.get("xoaf")).toBe("5");
  });

  it("sets tlang when requested (alongside kind), clears inherited tlang otherwise", () => {
    const withT = new URL(
      cloneWithLang(CAPTURED, "ja", { tlang: "en", kind: "asr" }),
    );
    expect(withT.searchParams.get("tlang")).toBe("en");
    expect(withT.searchParams.get("kind")).toBe("asr");

    const noT = new URL(
      cloneWithLang(`${CAPTURED}&tlang=fr`, "ja", { kind: "manual" }),
    );
    expect(noT.searchParams.get("tlang")).toBeNull();
  });
});

describe("parseJson3", () => {
  it("maps to {start,end,text} ms, sorts ascending, trims, drops empties", () => {
    const events = parseJson3([
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: "Hello" }] },
      { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "  Hi  " }] },
      { tStartMs: 3000, segs: [{ utf8: "" }] }, // empty text → dropped
      { dDurationMs: 100, segs: [{ utf8: "no start" }] }, // no tStartMs → dropped
    ]);
    expect(events).toEqual([
      { start: 1000, end: 1500, text: "Hi" },
      { start: 5000, end: 7000, text: "Hello" },
    ]);
  });
});
