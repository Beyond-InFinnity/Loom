import { describe, expect, it } from "vitest";

import { cloneWithLang, parseJson3 } from "./fanout";

const CAPTURED =
  "https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=srv3&pot=POTTOKEN&c=WEB&xoaf=5";

describe("cloneWithLang", () => {
  it("swaps lang + forces json3, preserving pot/session params", () => {
    const out = new URL(cloneWithLang(CAPTURED, "ja"));
    expect(out.searchParams.get("lang")).toBe("ja");
    expect(out.searchParams.get("fmt")).toBe("json3");
    expect(out.searchParams.get("pot")).toBe("POTTOKEN");
    expect(out.searchParams.get("c")).toBe("WEB");
  });

  it("sets tlang when requested; clears an inherited tlang otherwise", () => {
    const withT = new URL(cloneWithLang(CAPTURED, "ja", { tlang: "en" }));
    expect(withT.searchParams.get("tlang")).toBe("en");
    const noT = new URL(cloneWithLang(`${CAPTURED}&tlang=fr`, "ja"));
    expect(noT.searchParams.get("tlang")).toBeNull();
  });

  // Regression guard: a 0.1.1 change set kind=asr per target track and broke
  // auto-translate across languages in production. cloneWithLang must NOT
  // manipulate `kind` — it leaves whatever the captured URL inherited.
  it("does NOT touch `kind` (reverted 0.1.1 regression)", () => {
    expect(
      new URL(cloneWithLang(CAPTURED, "ja")).searchParams.get("kind"),
    ).toBeNull();
    expect(
      new URL(cloneWithLang(`${CAPTURED}&kind=asr`, "ja")).searchParams.get(
        "kind",
      ),
    ).toBe("asr");
  });
});

describe("parseJson3", () => {
  it("maps to {start,end,text} ms, sorts ascending, trims, drops empties", () => {
    const events = parseJson3([
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: "Hello" }] },
      { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "  Hi  " }] },
      { tStartMs: 3000, segs: [{ utf8: "" }] },
      { dDurationMs: 100, segs: [{ utf8: "no start" }] },
    ]);
    expect(events).toEqual([
      { start: 1000, end: 1500, text: "Hi" },
      { start: 5000, end: 7000, text: "Hello" },
    ]);
  });
});
