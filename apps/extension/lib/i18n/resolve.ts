import { baseLang } from "../annotate/define-lang";

// The UI locales Loom's chrome (popup + settings panel + pill + consent) is
// translated into.  The subtitle OUTPUT already works in every language; this is
// purely the interface text.  English is the canonical source table and the
// fallback for any unsupported browser language.
export const SUPPORTED_UI_LOCALES = [
  "en", "ja", "zh", "ko", "de", "fr", "es", "it", "uk", "ru",
] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_UI_LOCALES);

// Every Chinese variant maps to the Simplified UI table (a Traditional table can
// be added later under "zh-Hant"; the browser primary subtag doesn't distinguish
// script, and Simplified is the common default for a bare "zh").
const ZH_UI_PRIMARIES = new Set([
  "zh", "yue", "cmn", "wuu", "hak", "nan", "gan", "hsn",
]);

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
  const primary = baseLang(code);
  if (ZH_UI_PRIMARIES.has(primary)) return "zh";
  return SUPPORTED.has(primary) ? (primary as UiLocale) : "en";
}
