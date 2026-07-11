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

// LocaleProvider — seam #6 (MOBILE_ROADMAP.md §3).  The host registers how
// to read the UI language (extension: browser.i18n.getUILanguage(); native
// WebView: navigator.language or a shell-provided value).  Unregistered /
// throwing provider → English, preserving the old guarded-fallback behavior.
let uiLocaleProvider: () => string | null | undefined = () => null;

export function setUiLocaleProvider(
  provider: () => string | null | undefined,
): void {
  uiLocaleProvider = provider;
}

/** The host's RAW BCP-47 UI language (e.g. "de-AT"), unmapped — for consumers
    whose language space is broader than the 12 chrome locales (the dictionary
    gloss default).  Null when unregistered/unavailable. */
export function hostLocaleRaw(): string | null {
  try {
    return uiLocaleProvider() ?? null;
  } catch {
    return null;
  }
}

/** Resolve a BCP-47 code (e.g. the browser UI language) to one of our UI
    locales.  Unknown/unsupported languages fall back to English.  Pass an
    explicit code, or omit to read the host's registered locale provider
    (guarded — an unregistered or throwing provider falls back to English,
    e.g. tests / MAIN world). */
export function resolveUiLocale(raw?: string | null): UiLocale {
  let code = raw ?? "";
  if (!code) {
    try {
      code = uiLocaleProvider() ?? "";
    } catch {
      return "en";
    }
    if (!code) return "en";
  }
  const subtags = code.toLowerCase().split(/[-_]/).filter(Boolean);
  const primary = subtags[0] ?? "";
  if (primary === "yue" || subtags.includes("yue")) return "yue";
  if (ZH_PRIMARIES.has(primary)) return classifyChinese(subtags);
  return SUPPORTED.has(primary) ? (primary as UiLocale) : "en";
}
