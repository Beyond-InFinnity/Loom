import { describe, expect, it } from "vitest";

import { planWordGroups } from "./group-segments";
import type { AnnotateToken } from "./types";

const tok = (
  word: string,
  start: number,
  length: number,
  lemma: string | null = null,
): AnnotateToken => ({ word, start, length, lemma, pos: [] });

describe("planWordGroups", () => {
  it("wraps each token's run and leaves gaps loose", () => {
    // e.g. 我 喜欢 吃 with a trailing punctuation span (index 4):
    //   token 我[0:1], 喜欢[1:3], 吃[3:4]; span 4 uncovered
    const tokens = [tok("我", 0, 1), tok("喜欢", 1, 2), tok("吃", 3, 1)];
    const runs = planWordGroups(5, tokens);
    expect(runs).toEqual([
      { kind: "word", token: tokens[0], start: 0, length: 1 },
      { kind: "word", token: tokens[1], start: 1, length: 2 },
      { kind: "word", token: tokens[2], start: 3, length: 1 },
      { kind: "loose", index: 4 },
    ]);
  });

  it("covers exactly the token's span range", () => {
    const runs = planWordGroups(3, [tok("寿司", 1, 2)]);
    // span 0 loose, then the 2-span word starting at 1
    expect(runs).toEqual([
      { kind: "loose", index: 0 },
      { kind: "word", token: expect.objectContaining({ word: "寿司" }), start: 1, length: 2 },
    ]);
  });

  it("returns all-loose when there are no tokens", () => {
    expect(planWordGroups(3, [])).toEqual([
      { kind: "loose", index: 0 },
      { kind: "loose", index: 1 },
      { kind: "loose", index: 2 },
    ]);
    expect(planWordGroups(2, null)).toEqual([
      { kind: "loose", index: 0 },
      { kind: "loose", index: 1 },
    ]);
  });

  it("skips a token whose range overflows the segments (drift guard)", () => {
    // token claims length 3 but only 2 segments exist → not wrapped
    const runs = planWordGroups(2, [tok("x", 0, 3)]);
    expect(runs).toEqual([
      { kind: "loose", index: 0 },
      { kind: "loose", index: 1 },
    ]);
  });

  it("ignores zero-length tokens", () => {
    const runs = planWordGroups(1, [tok("", 0, 0)]);
    expect(runs).toEqual([{ kind: "loose", index: 0 }]);
  });
});
