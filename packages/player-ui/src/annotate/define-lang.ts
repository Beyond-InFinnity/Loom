// Language mapping for the per-word dictionary (/define).
//
// This is deliberately NOT an allowlist any more.  Which source languages are
// definable is decided by the SERVER (see capabilities.ts) so a new dictionary
// lights up with no extension release.  This module only NORMALIZES codes:
//   - a caption track's BCP-47 code -> the dictionary's source key, and
//   - picks a gloss language from what the server offers + the browser locale.

import { hostLocaleRaw } from "../i18n/resolve";
import type { DefineCapabilities } from "./capabilities";

/** Gloss languages available for a specific source language, per the server.
    Falls back to the global gloss list (then ["en"]) when the server hasn't
    declared a per-source map for it (older server, or the fallback). */
export function glossLangsForSource(
  caps: DefineCapabilities,
  sourceLang: string | null | undefined,
): string[] {
  const src = baseLang(sourceLang);
  const perSource = src ? caps.glossLangsBySource.get(src) : undefined;
  if (perSource && perSource.length) return perSource;
  return caps.glossLangs.length ? caps.glossLangs : ["en"];
}

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
    explicit override if it's available for this source language, else the
    browser UI language if available, else English (always available).

    When `sourceLang` is given the availability set is the gloss languages that
    actually have entries for THAT source (so a de override picked while watching
    Japanese doesn't leak onto a Spanish video that has no es→de dictionary);
    without it, the global gloss set is used. */
export function resolveGlossLang(
  caps: DefineCapabilities,
  override?: string | null,
  sourceLang?: string | null,
): string {
  const list =
    sourceLang !== undefined
      ? glossLangsForSource(caps, sourceLang)
      : caps.glossLangs.length
        ? caps.glossLangs
        : ["en"];
  const available = new Set(list.length ? list : ["en"]);
  const ov = override ? baseLang(override) : "";
  if (ov && available.has(ov)) return ov;
  // Host locale via the LocaleProvider seam (raw BCP-47, not one of the
  // 12 UI locales — gloss availability is broader than the chrome).
  const raw = hostLocaleRaw();
  const ui = raw ? baseLang(raw) : "en";
  return available.has(ui) ? ui : "en";
}
