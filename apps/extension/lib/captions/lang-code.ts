// Pure BCP-47 parser + script resolution.
//
// YouTube reports captionTracks[].languageCode as a BCP-47 tag.  The
// structural shapes we encounter in the wild:
//
//   2-letter ISO 639:          "en", "ja", "de"
//   3-letter ISO 639-3:        "yue", "cmn", "fil"
//   language + region:         "en-US", "en-GB", "pt-BR", "es-419"
//   language + script:         "zh-Hans", "zh-Hant", "sr-Latn"
//   language + script + region: "zh-Hans-CN", "zh-Hant-TW"
//
// BCP-47 subtags are positionally ambiguous but disambiguatable by
// SHAPE: a 4-letter subtag is a script (ISO 15924, Title-case), a
// 2-letter or 3-digit subtag in the trailing position is a region.
// We parse by shape, not by position, so unusual orderings still resolve.
//
// The `name` field on a CaptionTrack ("English (United States)",
// "Português (Brasil)") is display-only.  Authoritative matching
// always uses languageCode.

export interface ParsedLangCode {
  raw: string;
  /** Lowercased language subtag (ISO 639-1 or 639-3).  Empty string
      on malformed input. */
  language: string;
  /** Script subtag if present, in canonical Title-case ("Hans",
      "Hant", "Cyrl", "Latn"). */
  script: string | null;
  /** Region subtag if present.  Uppercased for 2-letter ISO 3166-1
      ("US", "GB", "BR"); 3-digit UN M.49 codes pass through ("419"). */
  region: string | null;
}

const SCRIPT_SHAPE = /^[A-Za-z]{4}$/;
const REGION_2_SHAPE = /^[A-Za-z]{2}$/;
const REGION_3_SHAPE = /^[0-9]{3}$/;

export function parseBcp47(code: string): ParsedLangCode {
  const raw = code;
  const trimmed = code.trim();
  if (!trimmed) return { raw, language: "", script: null, region: null };

  const parts = trimmed.split("-");
  const language = (parts[0] ?? "").toLowerCase();
  let script: string | null = null;
  let region: string | null = null;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (!script && SCRIPT_SHAPE.test(p)) {
      script = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    } else if (!region && REGION_2_SHAPE.test(p)) {
      region = p.toUpperCase();
    } else if (!region && REGION_3_SHAPE.test(p)) {
      region = p;
    }
  }
  return { raw, language, script, region };
}

// Default script for languages whose written form is NOT Latin.  Any
// language absent from this map defaults to Latn — which is the right
// guess for the long tail of European / SE Asian / African / Polynesian
// languages.
//
// Entries are keyed by base ISO 639 subtag; region-aware overrides
// (zh-TW → Hant) are handled in resolveScript() below.
const LANG_DEFAULT_SCRIPT: Record<string, string> = {
  ja: "Jpan",
  ko: "Kore",
  zh: "Hans",
  yue: "Hant",
  cmn: "Hans",
  nan: "Hant",
  wuu: "Hans",
  hak: "Hant",
  ru: "Cyrl",
  uk: "Cyrl",
  be: "Cyrl",
  bg: "Cyrl",
  mk: "Cyrl",
  mn: "Cyrl",
  sr: "Cyrl",
  kk: "Cyrl",
  ky: "Cyrl",
  tg: "Cyrl",
  ab: "Cyrl",
  os: "Cyrl",
  cv: "Cyrl",
  ba: "Cyrl",
  tt: "Cyrl",
  sah: "Cyrl",
  th: "Thai",
  lo: "Laoo",
  km: "Khmr",
  my: "Mymr",
  bo: "Tibt",
  dz: "Tibt",
  he: "Hebr",
  iw: "Hebr",
  yi: "Hebr",
  ji: "Hebr",
  ar: "Arab",
  fa: "Arab",
  ps: "Arab",
  ur: "Arab",
  sd: "Arab",
  ckb: "Arab",
  ku: "Arab",
  ug: "Arab",
  hi: "Deva",
  mr: "Deva",
  ne: "Deva",
  sa: "Deva",
  kok: "Deva",
  bn: "Beng",
  as: "Beng",
  ta: "Taml",
  te: "Telu",
  gu: "Gujr",
  pa: "Guru",
  ml: "Mlym",
  kn: "Knda",
  si: "Sinh",
  or: "Orya",
  am: "Ethi",
  ti: "Ethi",
  ka: "Geor",
  hy: "Armn",
  dv: "Thaa",
  chr: "Cher",
};

/** Resolve the script for a parsed lang code.  Explicit script subtag
    wins.  Else, region-aware override for zh (CN→Hans, TW/HK/MO→Hant).
    Else, look up base language in LANG_DEFAULT_SCRIPT.  Else, default
    to Latn — covers the long tail of European / SE Asian / African /
    Polynesian languages without enumerating them. */
export function resolveScript(parsed: ParsedLangCode): string {
  if (parsed.script) return parsed.script;
  if (parsed.language === "zh") {
    if (
      parsed.region === "TW" ||
      parsed.region === "HK" ||
      parsed.region === "MO"
    ) {
      return "Hant";
    }
    return "Hans";
  }
  return LANG_DEFAULT_SCRIPT[parsed.language] ?? "Latn";
}

export function baseLang(code: string): string {
  return parseBcp47(code).language;
}

// Canonicalize deprecated / alias language tags.  ISO 639 has been
// revised across decades and YouTube data occasionally surfaces older
// codes (iw for he, in for id, ji for yi).  Returns canonical form.
const LANG_ALIASES: Record<string, string> = {
  iw: "he",
  in: "id",
  ji: "yi",
  jw: "jv",
  mo: "ro",
};

export function canonicalBaseLang(code: string): string {
  const base = baseLang(code);
  return LANG_ALIASES[base] ?? base;
}
