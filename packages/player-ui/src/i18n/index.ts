import { resolveUiLocale, type UiLocale } from "./resolve";
import { en, type StringKey, type LocaleTable } from "./strings/en";
import { ja } from "./strings/ja";
import { zh } from "./strings/zh";
import { zhHant } from "./strings/zh-hant";
import { yue } from "./strings/yue";
import { ko } from "./strings/ko";
import { de } from "./strings/de";
import { fr } from "./strings/fr";
import { es } from "./strings/es";
import { it } from "./strings/it";
import { uk } from "./strings/uk";
import { ru } from "./strings/ru";

export type { StringKey, LocaleTable } from "./strings/en";
export type { UiLocale } from "./resolve";

const TABLES: Record<UiLocale, LocaleTable> = {
  en,
  ja,
  zh,
  "zh-Hant": zhHant,
  yue,
  ko,
  de,
  fr,
  es,
  it,
  uk,
  ru,
};

let activeLocale: UiLocale = "en";
let activeTable: LocaleTable = en;

/** Resolve and lock in the UI locale for this context (popup, onboarding, or the
    in-page overlay).  Call once at entrypoint startup; `t()` is a no-op-safe
    English fallback until it runs.  Pass an explicit code to force a locale
    (tests, a future user override); omit to read the browser UI language. */
export function initUiLocale(raw?: string | null): UiLocale {
  activeLocale = resolveUiLocale(raw);
  activeTable = TABLES[activeLocale];
  return activeLocale;
}

export function getUiLocale(): UiLocale {
  return activeLocale;
}

const PARAM_RE = /\{(\w+)\}/g;

/** Translate a string key into the active UI locale, interpolating `{name}`
    placeholders from `params`.  Missing translations fall back to English;
    a missing English key (should never happen — the table is exhaustive) falls
    back to the key itself so nothing renders blank. */
export function t(
  key: StringKey,
  params?: Record<string, string | number>,
): string {
  const template = activeTable[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(PARAM_RE, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Locale-correct display name for a BCP-47 language code (e.g. "ja" → "日本語"
    in the ja UI, "Japanese" in en), via Intl.DisplayNames.  Falls back to the
    raw code if the runtime can't name it.  Used for the language pickers so the
    49-entry name list is never hand-translated. */
export function languageName(code: string): string {
  try {
    const dn = new Intl.DisplayNames([activeLocale], { type: "language" });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
}
