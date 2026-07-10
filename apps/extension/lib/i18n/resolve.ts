// The UI locales Loom's chrome (popup + settings panel + pill + consent) is
// translated into.  The subtitle OUTPUT already works in every language; this is
// purely the interface text.  English is the canonical source table and the
// fallback for any unsupported browser language.
export const SUPPORTED_UI_LOCALES = [
  "en", "ja", "zh", "zh-Hant", "yue", "ko", "de", "fr", "es", "it", "uk", "ru",
] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_UI_LOCALES);

// Chinese primary subtags (Mandarin macrolanguage + the Sinitic tongues that a
// browser may report). "yue" (Cantonese) is handled first and separately.
const ZH_PRIMARIES = new Set([
  "zh", "cmn", "wuu", "hak", "nan", "gan", "hsn",
]);

// Map a Chinese BCP-47 code to a script-specific UI table.  Standard Written
// Chinese has two script tables — Simplified ("zh") and Traditional ("zh-Hant").
// Routing: explicit script subtag wins (Hans/Hant); else by region (TW/HK/MO →
// Traditional, CN/SG/MY/bare → Simplified).  zh-HK deliberately routes to formal
// Traditional, NOT the colloquial Cantonese table — HK UIs are written in
// Standard Written Chinese; the "yue" table is an informal register reachable
// only via an explicit "yue"/"zh-yue" code (or a future manual locale picker).
function classifyChinese(subtags: string[]): UiLocale {
  if (subtags.includes("hant")) return "zh-Hant";
  if (subtags.includes("hans")) return "zh";
  if (
    subtags.includes("tw") ||
    subtags.includes("hk") ||
    subtags.includes("mo")
  ) {
    return "zh-Hant";
  }
  return "zh";
}

/** Resolve a BCP-47 code (e.g. the browser UI language) to one of our UI
    locales.  Unknown/unsupported languages fall back to English.  Pass an
    explicit code, or omit to read `browser.i18n.getUILanguage()` (guarded — the
    API is unavailable in some contexts, e.g. tests / MAIN world). */
export function resolveUiLocale(raw?: string | null): UiLocale {
  let code = raw ?? "";
  if (!code) {
    try {
      code = browser.i18n.getUILanguage();
    } catch {
      return "en";
    }
  }
  const subtags = code.toLowerCase().split(/[-_]/).filter(Boolean);
  const primary = subtags[0] ?? "";
  if (primary === "yue" || subtags.includes("yue")) return "yue";
  if (ZH_PRIMARIES.has(primary)) return classifyChinese(subtags);
  return SUPPORTED.has(primary) ? (primary as UiLocale) : "en";
}
