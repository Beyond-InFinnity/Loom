import { describe, expect, it } from "vitest";
import { getVariantById, type OrthographyTable } from "@loom/orthography-tables";
import { buildRichSegments } from "./build-segments";
import type { AnnotateSpan } from "@/lib/annotate/types";

const ZH_TABLE: OrthographyTable = getVariantById("zh-hant-to-hans").table;

describe("buildRichSegments — combination matrix", () => {
  it("plain text only (no spans, no table) → single plain segment", () => {
    const segs = buildRichSegments({
      spans: null,
      rawText: "尿酸580套",
      variantTable: null,
    });
    expect(segs).toEqual([{ kind: "plain", text: "尿酸580套" }]);
  });

  it("empty everything → empty array", () => {
    expect(buildRichSegments({ spans: null, rawText: "", variantTable: null })).toEqual([]);
    expect(buildRichSegments({ spans: [], rawText: "", variantTable: ZH_TABLE })).toEqual([]);
  });

  it("coalescePlain=false keeps segments 1:1 with spans (word-grouping invariant)", () => {
    // Two adjacent reading-less spans: coalesced by default, but word-level
    // vocab lookup needs one segment per span so token span-indices align.
    const spans: AnnotateSpan[] = [
      { base: "。", reading: null },
      { base: "。", reading: null },
      { base: "你", reading: "nǐ" },
    ];
    const coalesced = buildRichSegments({ spans, rawText: "。。你", variantTable: null });
    expect(coalesced).toHaveLength(2); // "。。" merged + 你

    const uncoalesced = buildRichSegments({
      spans,
      rawText: "。。你",
      variantTable: null,
      coalescePlain: false,
    });
    expect(uncoalesced).toHaveLength(spans.length); // strict 1:1
    expect(uncoalesced.map((s) => (s.kind === "plain" ? s.text : s.base))).toEqual([
      "。",
      "。",
      "你",
    ]);
  });

  it("spans only (no table) → over-ruby only segments", () => {
    const spans: AnnotateSpan[] = [
      { base: "我", reading: "ㄨㄛˇ" },
      { base: "們", reading: "ㄇㄣ˙" },
    ];
    const segs = buildRichSegments({ spans, rawText: "我們", variantTable: null });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({
      kind: "annotated",
      base: "我",
      reading: "ㄨㄛˇ",
      variantForm: null,
      highlightTier: "none",
    });
    expect(segs[1]).toEqual({
      kind: "annotated",
      base: "們",
      reading: "ㄇㄣ˙",
      variantForm: null,
      highlightTier: "none",
    });
  });

  it("raw text + table (no spans) → under-ruby only for in-table chars", () => {
    // The target example from the spec — should annotate ONLY 買 and 華.
    const segs = buildRichSegments({
      spans: null,
      rawText: "尿酸580套健保卡買中華",
      variantTable: ZH_TABLE,
    });
    // Plain run "尿酸580套健保卡" + annotated 買 + plain "中" + annotated 華.
    expect(segs).toHaveLength(4);
    expect(segs[0]).toEqual({ kind: "plain", text: "尿酸580套健保卡" });
    expect(segs[1]).toMatchObject({
      kind: "annotated",
      base: "買",
      reading: null,
      variantForm: "买",
      highlightTier: "clean",
    });
    expect(segs[2]).toEqual({ kind: "plain", text: "中" });
    expect(segs[3]).toMatchObject({
      kind: "annotated",
      base: "華",
      reading: null,
      variantForm: "华",
      highlightTier: "clean",
    });
  });

  it("spans + table → both rubies layered per single-codepoint span", () => {
    const spans: AnnotateSpan[] = [
      { base: "髮", reading: "ㄈㄚˇ" },   // forward-collapse case (collapse=[發])
      { base: "型", reading: "ㄒㄧㄥˊ" }, // not in table — clean over-ruby only
    ];
    const segs = buildRichSegments({
      spans,
      rawText: "髮型",
      variantTable: ZH_TABLE,
    });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({
      kind: "annotated",
      base: "髮",
      reading: "ㄈㄚˇ",
      variantForm: "发",
      highlightTier: "collapse",
    });
    expect(segs[1]).toEqual({
      kind: "annotated",
      base: "型",
      reading: "ㄒㄧㄥˊ",
      variantForm: null,
      highlightTier: "none",
    });
  });
});

describe("buildRichSegments — highlight tier rules", () => {
  it("clean 1:1 → tier 'clean' (語/語 has empty collapse)", () => {
    const segs = buildRichSegments({
      spans: null,
      rawText: "語",
      variantTable: ZH_TABLE,
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: "annotated",
      base: "語",
      variantForm: "语",
      highlightTier: "clean",
    });
  });

  it("forward-collapse → tier 'collapse' (髮 collapses with 發 → 发)", () => {
    const segs = buildRichSegments({
      spans: null,
      rawText: "髮",
      variantTable: ZH_TABLE,
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: "annotated",
      base: "髮",
      variantForm: "发",
      highlightTier: "collapse",
    });
  });

  it("absent char gets no tier (山 is unchanged)", () => {
    const segs = buildRichSegments({
      spans: null,
      rawText: "山",
      variantTable: ZH_TABLE,
    });
    expect(segs).toEqual([{ kind: "plain", text: "山" }]);
  });
});

describe("buildRichSegments — multi-codepoint span guard", () => {
  it("multi-char base (Japanese kanji compound) keeps over-ruby; no under-ruby attempted", () => {
    // Even if the chars happened to be in the Chinese table, a multi-
    // codepoint base shouldn't be split — the reading is for the whole
    // word, not per-char.
    const spans: AnnotateSpan[] = [{ base: "日本", reading: "にほん" }];
    const segs = buildRichSegments({
      spans,
      rawText: "日本",
      variantTable: ZH_TABLE,
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      kind: "annotated",
      base: "日本",
      reading: "にほん",
      variantForm: null,
      highlightTier: "none",
    });
  });

  it("plain-run coalescing across multiple absent chars (no DOM fragmentation)", () => {
    // walkRawTextWithTable should merge consecutive plain chars into
    // one segment so the renderer emits one <span>, not N.
    const segs = buildRichSegments({
      spans: null,
      rawText: "尿酸",
      variantTable: ZH_TABLE,
    });
    expect(segs).toEqual([{ kind: "plain", text: "尿酸" }]);
  });

  it("plain-run coalescing across multiple no-annotation spans", () => {
    // mergeSpansWithTable: consecutive spans with no reading and no
    // variant entry should collapse to one plain segment.
    const spans: AnnotateSpan[] = [
      { base: "「" },
      { base: "、" },
      { base: "！" },
    ];
    const segs = buildRichSegments({ spans, rawText: "", variantTable: ZH_TABLE });
    expect(segs).toEqual([{ kind: "plain", text: "「、！" }]);
  });
});

describe("buildRichSegments — null reading on AnnotateSpan", () => {
  it("treats undefined reading the same as null", () => {
    const spans: AnnotateSpan[] = [{ base: "我" }];
    const segs = buildRichSegments({
      spans,
      rawText: "我",
      variantTable: null,
    });
    // No reading, no table entry → coalesced into plain segment.
    expect(segs).toEqual([{ kind: "plain", text: "我" }]);
  });
});
