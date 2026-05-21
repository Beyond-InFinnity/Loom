// AnnotateSpan shape — one token of base text with optional phonetic
// reading (e.g., kanji + hiragana, hanzi + pinyin/zhuyin/jyutping,
// hangul + RR).  Mirrors components.schemas.AnnotateSpan from
// @loom/api-client.  Vendored to avoid leaking the api-client's deep
// schema type into every consumer; field shape is the load-bearing
// contract and unlikely to change.

export interface AnnotateSpan {
  base: string;
  /** null when the base token doesn't need annotation — punctuation,
      kana on its own in a Japanese line, latin letters mixed into
      Chinese, etc. */
  reading?: string | null;
}

/** Map keyed by an event's raw text → its parsed annotation spans.
    Returned by buildAnnotateMap; consumed by AnnotatedText. */
export type AnnotateMap = Map<string, AnnotateSpan[]>;
