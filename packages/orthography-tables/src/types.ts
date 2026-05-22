// Orthography-variant annotation tables.
//
// A "variant table" maps characters in a SOURCE orthography to the
// corresponding form in a TARGET orthography of the SAME language.
// This is a static, deterministic, single-character lookup — NOT a
// phonetic transform (that's /romanize) and NOT a per-character reading
// annotation (that's /annotate).
//
// Only forward-deterministic mappings qualify for this layer.  The
// canonical example is Traditional Chinese → Simplified Chinese: each
// traditional char has exactly one preferred simplified form.  The
// reverse (simp → trad) is lossy and is categorically OUT OF SCOPE —
// see the commented seam in registry.ts.
//
// The "collapse" array records OTHER source chars that forward-map to
// the same target form.  A non-empty collapse means a reader of the
// target orthography could not have uniquely recovered this character —
// the pedagogically significant case.
//
// Future variant ids (NOT BUILT) would slot in as additional tables:
//   - `ja-pre-modern-to-modern-kana` (historical kana → gendai kana)
//   - `sr-Cyrl-to-Latn` (Serbian Cyrillic ↔ Latin)
//   - `kk-Cyrl-to-Latn` (Kazakh Cyrillic ↔ Latin)
// Each would be a new JSON under data/ and a new registry entry.

export interface OrthographyEntry {
  /** Target-orthography form.  Exactly one value — the mapping is a function. */
  to: string;
  /**
   * Other source-orthography chars that forward-map to the same `to` form.
   * Empty for clean 1:1 mappings (e.g. 語→语).
   * Non-empty for merge cases (e.g. 髮 lists 發 since both → 发).
   */
  collapse: string[];
}

/** Map from source char (single codepoint) → entry.  Chars absent from
 * the table are unchanged across the variant pair and should NOT be
 * annotated or highlighted. */
export type OrthographyTable = Record<string, OrthographyEntry>;

/** Stable, orthography-neutral identifier for a variant table.
 * Naming convention: `<lang>-<from-script-or-form>-to-<to-script-or-form>`. */
export type VariantId = "zh-hant-to-hans";

export interface VariantDescriptor {
  id: VariantId;
  /** User-facing label naming the concrete target form (e.g. "Simplified"). */
  targetLabel: string;
  /** ISO 15924 / BCP-47 hint for the source orthography. */
  sourceHint: string;
  /** ISO 15924 / BCP-47 hint for the target orthography. */
  targetHint: string;
  table: OrthographyTable;
}
