// Romanization map shape for the 5e secondary phonetic line.
//
// Where the annotate map (5d) carries per-token spans (base + reading)
// for ruby rendering, the romanize map carries a single full-utterance
// string per source text — "kyou wa kaisha ni ikimasu" for the whole
// Japanese line, not per-kanji.  The 4th overlay slot (above
// Annotation) renders this plain.
//
// Returned by buildRomanizeMap; consumed by the caption overlay's
// Romanization layer.

/** Map keyed by an event's raw (trimmed) text → its full-utterance
    romanization.  Empty / failed entries are simply absent from the
    map — the overlay falls back to rendering nothing in the
    Romanization slot. */
export type RomanizeMap = Map<string, string>;
