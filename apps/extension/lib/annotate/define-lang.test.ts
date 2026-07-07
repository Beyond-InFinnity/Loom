import { describe, expect, it } from "vitest";

import { defineLangFor } from "./define-lang";

describe("defineLangFor", () => {
  it("maps Japanese to ja", () => {
    expect(defineLangFor("ja")).toBe("ja");
    expect(defineLangFor("ja-JP")).toBe("ja");
    expect(defineLangFor("JA")).toBe("ja");
  });

  it("maps all Chinese variants to zh (shared CC-CEDICT)", () => {
    for (const code of ["zh", "zh-Hans", "zh-Hant", "zh-TW", "zh-HK", "yue", "zh_hant"]) {
      expect(defineLangFor(code)).toBe("zh");
    }
  });

  it("returns null for unsupported languages", () => {
    for (const code of ["ko", "th", "en", "hi", "ru"]) {
      expect(defineLangFor(code)).toBeNull();
    }
  });

  it("returns null for empty / nullish input", () => {
    expect(defineLangFor(null)).toBeNull();
    expect(defineLangFor(undefined)).toBeNull();
    expect(defineLangFor("")).toBeNull();
  });
});
