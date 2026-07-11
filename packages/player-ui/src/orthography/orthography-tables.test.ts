import { describe, expect, it } from "vitest";
import {
  getVariantById,
  lookupChar,
  resolveOrthographyVariants,
  type OrthographyTable,
} from "@loom/orthography-tables";

// Pass-1 tests for the orthography-variant annotation layer.
//
// These verify the DATA + the REGISTRY GATE only.  Rendering (Pass 2)
// is covered separately once the layer is wired into caption-overlay.

describe("zh-hant-to-hans table — spot checks", () => {
  const table = getVariantById("zh-hant-to-hans").table;

  it("髮 and 發 both map to 发 with each other in collapse (forward-collapse case)", () => {
    // The pedagogically significant case: two distinct traditional
    // chars share one simplified target — a reader of simplified could
    // not uniquely recover which one was meant.
    expect(table["髮"]).toEqual({ to: "发", collapse: ["發"] });
    expect(table["發"]).toEqual({ to: "发", collapse: ["髮"] });
  });

  it("語 maps to 语 with empty collapse (clean 1:1)", () => {
    expect(table["語"]).toEqual({ to: "语", collapse: [] });
  });

  it("山 is absent (unchanged across the variant pair → no annotation)", () => {
    expect(table["山"]).toBeUndefined();
    expect(lookupChar(table, "山")).toBeNull();
  });
});

describe("zh-hant-to-hans table — invariants", () => {
  const table: OrthographyTable = getVariantById("zh-hant-to-hans").table;

  it("has a non-trivial population (>3000 entries)", () => {
    expect(Object.keys(table).length).toBeGreaterThan(3000);
  });

  it("every entry has a non-empty `to` field of length 1", () => {
    for (const [src, entry] of Object.entries(table)) {
      expect(entry.to, `entry for ${src}`).toBeTruthy();
      // Some CJK chars are surrogate pairs (length 2 in JS string).
      // The constraint is "one user-perceived character", not "one JS code unit".
      const codepoints = [...entry.to];
      expect(codepoints.length, `entry for ${src}`).toBe(1);
    }
  });

  it("`to` is always different from source (same-form rows must be filtered)", () => {
    for (const [src, entry] of Object.entries(table)) {
      expect(entry.to, `${src} should not map to itself`).not.toBe(src);
    }
  });

  it("inversion consistency — every collapse sibling is itself a key with the same `to`", () => {
    // For each entry { src → {to, collapse: [sib1, sib2]} }, each sibling
    // sibN must also be a key in the table, AND its own `to` must equal
    // this entry's `to`.  This guarantees the reverse-multimap was
    // computed consistently.
    for (const [src, entry] of Object.entries(table)) {
      for (const sib of entry.collapse) {
        const sibEntry = table[sib];
        expect(sibEntry, `collapse sibling ${sib} of ${src} must exist as a key`).toBeDefined();
        expect(sibEntry!.to, `${sib} should share ${src}'s target`).toBe(entry.to);
        // The sibling's own collapse must list `src` back.
        expect(sibEntry!.collapse, `${sib} should list ${src} as a sibling`).toContain(src);
      }
    }
  });

  it("has at least some non-empty collapse entries (forward-collapse merge cases exist)", () => {
    const withCollapse = Object.values(table).filter((e) => e.collapse.length > 0);
    expect(withCollapse.length).toBeGreaterThan(100);
  });
});

describe("variant registry — resolution gate", () => {
  it("resolves Traditional Chinese (zh-Hant) to the table", () => {
    const variants = resolveOrthographyVariants("zh-Hant");
    expect(variants).toHaveLength(1);
    expect(variants[0]!.id).toBe("zh-hant-to-hans");
  });

  it("resolves zh-TW / zh-HK / zh-MO via region (no explicit script)", () => {
    for (const code of ["zh-TW", "zh-HK", "zh-MO"]) {
      const variants = resolveOrthographyVariants(code);
      expect(variants, code).toHaveLength(1);
      expect(variants[0]!.id, code).toBe("zh-hant-to-hans");
    }
  });

  it("resolves yue (Cantonese) to the table — defaults to traditional", () => {
    expect(resolveOrthographyVariants("yue")).toHaveLength(1);
    expect(resolveOrthographyVariants("yue-Hant")).toHaveLength(1);
  });

  it("does NOT resolve Simplified Chinese (zh-Hans, zh-CN) — reverse direction is out of scope", () => {
    expect(resolveOrthographyVariants("zh-Hans")).toEqual([]);
    expect(resolveOrthographyVariants("zh-CN")).toEqual([]);
  });

  it("does NOT resolve generic zh / unmarked zh", () => {
    // Generic "zh" with no script/region hint is ambiguous; we don't
    // assume a default — better to render nothing than to mislabel.
    expect(resolveOrthographyVariants("zh")).toEqual([]);
  });

  it("does NOT resolve non-Chinese languages — gate is data-driven, not hardcoded around 'zh'", () => {
    for (const code of ["ja", "ko", "en", "fr", "ar", "he", "th", "ru", "hi", "vi"]) {
      expect(resolveOrthographyVariants(code), code).toEqual([]);
    }
  });

  it("does NOT resolve regional variants of non-Chinese languages (e.g. en-GB)", () => {
    expect(resolveOrthographyVariants("en-GB")).toEqual([]);
    expect(resolveOrthographyVariants("pt-BR")).toEqual([]);
  });

  it("tolerates underscore-separated BCP-47 input", () => {
    expect(resolveOrthographyVariants("zh_Hant")).toHaveLength(1);
    expect(resolveOrthographyVariants("zh_TW")).toHaveLength(1);
  });
});

describe("variant registry — descriptor surface", () => {
  it("zh-hant-to-hans descriptor exposes orthography-neutral metadata", () => {
    const v = getVariantById("zh-hant-to-hans");
    expect(v.id).toBe("zh-hant-to-hans");
    expect(v.targetLabel).toBe("Simplified");
    expect(v.sourceHint).toBe("zh-Hant");
    expect(v.targetHint).toBe("zh-Hans");
    expect(v.table).toBeTypeOf("object");
  });
});
