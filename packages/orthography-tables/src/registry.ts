// Variant registry: BCP-47 lang code → applicable orthography variant(s).
//
// Today exactly ONE entry: zh-hant-to-hans.  The shape is a small map
// of `VariantId → VariantDescriptor` plus a list of resolution rules.
// Adding a future variant (e.g. ja-pre-modern-kana, sr-Cyrl-to-Latn) is
// one new descriptor + one new rule — the resolver and renderer don't
// change.
//
// The resolver is intentionally data-driven: callers don't get a
// hardcoded `if zh-Hant` branch anywhere downstream.  This keeps the
// "absence of a table means do nothing" contract clean.
//
// **Out of scope** (commented seams; do not build):
//   - REVERSE direction `zh-hans-to-hant`: lossy (一個 simp 字 ↔ many
//     trad alternatives by context).  Would need disambiguation we
//     cannot do statically.  If we ever want it, it'd be a DIFFERENT
//     layer with a different UX (suggestions, not annotations).
//   - Hindi ↔ Urdu abjad-vowel cases: lossy in both directions.

import zhHantToHansData from "../data/zh-hant-to-hans.json" with { type: "json" };
import type {
  OrthographyTable,
  VariantDescriptor,
  VariantId,
} from "./types.js";

// JSON imports come back typed as a record-with-known-keys; cast to the
// canonical shape so callers see OrthographyTable directly.
const zhHantToHansTable = zhHantToHansData as OrthographyTable;

const VARIANTS: Record<VariantId, VariantDescriptor> = {
  "zh-hant-to-hans": {
    id: "zh-hant-to-hans",
    targetLabel: "Simplified",
    sourceHint: "zh-Hant",
    targetHint: "zh-Hans",
    table: zhHantToHansTable,
  },
};

/**
 * Resolution rules: which BCP-47 (language, script) combinations
 * activate which variant.  Order doesn't matter — at most one variant
 * id per pair today, but the type allows multiple if a future language
 * has both an orthography variant AND a script transliteration variant
 * available.
 */
interface ResolutionRule {
  /** Lowercase BCP-47 primary language subtag. */
  language: string;
  /**
   * ISO 15924 script subtag (Title case as it appears in BCP-47).
   * `null` means "applies regardless of script subtag" — used when the
   * region implies the script.
   */
  script: string | null;
  /**
   * Lowercase region subtag(s) that further narrow the match.  Empty
   * array means region doesn't matter.
   */
  regions: string[];
  variant: VariantId;
}

const RULES: ResolutionRule[] = [
  // Traditional Chinese — any of zh-Hant, zh-TW, zh-HK, zh-MO.
  // yue (Cantonese) defaults to traditional script as well.
  { language: "zh", script: "Hant", regions: [], variant: "zh-hant-to-hans" },
  { language: "zh", script: null, regions: ["tw", "hk", "mo"], variant: "zh-hant-to-hans" },
  { language: "yue", script: "Hant", regions: [], variant: "zh-hant-to-hans" },
  { language: "yue", script: null, regions: [], variant: "zh-hant-to-hans" },
  // SEAM: future entries slot in here, e.g.:
  //   { language: "ja", script: null, regions: [], variant: "ja-historical-to-modern-kana" }
  //   { language: "sr", script: "Cyrl", regions: [], variant: "sr-cyrl-to-latn" }
];

/** Minimal shape-based BCP-47 parse, just enough to drive RULES. */
function parseLang(code: string): { language: string; script: string | null; region: string | null } {
  const subtags = code.trim().split(/[-_]/).filter(Boolean);
  const language = (subtags[0] ?? "").toLowerCase();
  let script: string | null = null;
  let region: string | null = null;
  for (let i = 1; i < subtags.length; i++) {
    const tag = subtags[i]!;
    if (tag.length === 4 && /^[A-Za-z]{4}$/.test(tag)) {
      script = tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase();
    } else if ((tag.length === 2 && /^[A-Za-z]{2}$/.test(tag)) || /^\d{3}$/.test(tag)) {
      region = tag.toLowerCase();
    }
  }
  return { language, script, region };
}

/**
 * Returns the variant descriptors that apply to a given BCP-47 language
 * code.  Empty array means "no orthography variant for this language" —
 * UI should NOT render the toggle; renderer should NOT emit under-ruby.
 *
 * Currently returns at most one descriptor; the array shape leaves room
 * for languages that could carry both an orthography AND a script
 * variant simultaneously.
 */
export function resolveOrthographyVariants(langCode: string): VariantDescriptor[] {
  const { language, script, region } = parseLang(langCode);
  if (!language) return [];

  const matches: VariantDescriptor[] = [];
  const seen = new Set<VariantId>();
  for (const rule of RULES) {
    if (rule.language !== language) continue;
    if (rule.script !== null && rule.script !== script) continue;
    if (rule.regions.length > 0) {
      if (!region || !rule.regions.includes(region)) continue;
    }
    if (!seen.has(rule.variant)) {
      seen.add(rule.variant);
      matches.push(VARIANTS[rule.variant]);
    }
  }
  return matches;
}

/** Direct lookup by id — for callers that know the variant they want. */
export function getVariantById(id: VariantId): VariantDescriptor {
  return VARIANTS[id];
}

/**
 * Lookup a single character in a variant table.  Returns `null` if the
 * character is absent (which the renderer MUST interpret as "do not
 * annotate, do not highlight" — absence is meaningful).
 */
export function lookupChar(
  table: OrthographyTable,
  ch: string,
): OrthographyTable[string] | null {
  return table[ch] ?? null;
}
