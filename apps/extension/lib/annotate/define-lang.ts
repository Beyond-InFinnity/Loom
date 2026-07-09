// Language mapping for the per-word dictionary (/define).
//
// This is deliberately NOT an allowlist any more.  Which source languages are
// definable is decided by the SERVER (see capabilities.ts) so a new dictionary
// lights up with no extension release.  This module only NORMALIZES codes:
//   - a caption track's BCP-47 code -> the dictionary's source key, and
//   - picks a gloss language from what the server offers + the browser locale.

import type { DefineCapabilities } from "./capabilities";

/** Base subtag, lowercased: "zh-Hant" -> "zh", "en-US" -> "en". */
export function baseLang(code: string | null | undefined): string {
  return (code ?? "").toLowerCase().split(/[-_]/)[0];
}

/** Chinese primary subtags that all share one dictionary source (CC-CEDICT is
    keyed "zh" for every variant, including Cantonese). */
const ZH_PRIMARIES = new Set([
  "zh", "yue", "wuu", "hak", "nan", "gan", "hsn", "cmn",
]);

/** Normalize a track's language code to the `/define` source key.  All Chinese
    variants collapse to "zh"; everything else is its base subtag.  NEVER null —
    the server's capabilities, not this function, decide if a dictionary exists. */
export function normalizeDefineSourceLang(code: string | null | undefined): string {
  const primary = baseLang(code);
  return ZH_PRIMARIES.has(primary) ? "zh" : primary;
}

/** Whether the track's language currently has a dictionary + tokenizer, per the
    server's capabilities.  Drives per-word interactivity without a hardcoded
    language list. */
export function isDefinable(
  caps: DefineCapabilities,
  code: string | null | undefined,
): boolean {
  const src = normalizeDefineSourceLang(code);
  return !!src && caps.sourceLangs.has(src);
}

/** Pick the gloss language (the language definitions are written in): the user's
    explicit override if the server offers it, else the browser UI language if
    offered, else English (always available). */
export function resolveGlossLang(
  caps: DefineCapabilities,
  override?: string | null,
): string {
  const available = new Set(caps.glossLangs.length ? caps.glossLangs : ["en"]);
  const ov = override ? baseLang(override) : "";
  if (ov && available.has(ov)) return ov;
  let ui = "en";
  try {
    ui = baseLang(browser.i18n.getUILanguage());
  } catch {
    // browser.i18n unavailable in some contexts — default to en
  }
  return available.has(ui) ? ui : "en";
}
