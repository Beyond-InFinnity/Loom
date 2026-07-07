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

/** Word-level grouping over an event's spans, for per-word vocab lookup
    (VOCAB_LOOKUP.md Phase 0/2).  `spans[start : start+length]` compose the
    word; `lemma` is the dictionary form for /define (Japanese), else null.
    Only Japanese + Chinese populate tokens; other langs return [].  Mirrors
    components.schemas.AnnotateToken from @loom/api-client. */
export interface AnnotateToken {
  word: string;
  /** Dictionary form for /define lookup (Japanese); null → use `word`. */
  lemma?: string | null;
  /** Part-of-speech tags (Japanese); [] for Chinese. */
  pos?: string[];
  /** Index into the event's spans where this word begins. */
  start: number;
  /** Number of spans this word covers. */
  length: number;
}

/** Map keyed by an event's raw text → its word-level tokens. */
export type AnnotateTokenMap = Map<string, AnnotateToken[]>;

/** Bundle returned by buildAnnotateMap: spans (for ruby rendering, unchanged)
    plus the parallel word-level token map (for per-word vocab lookup). */
export interface AnnotateResult {
  spans: AnnotateMap;
  tokens: AnnotateTokenMap;
}
