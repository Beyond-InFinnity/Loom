// Language classification: derive processing pipeline from a BCP-47 tag.
//
// The classification answers: "what does Loom need to do with this
// caption track to make it useful?"
//
//   native-display    Latin-script.  Show the text as-is; no
//                     romanization, no annotation needed.  Examples:
//                     en, de, fr, es, pt, it, nl, sv, da, fi, pl, cs,
//                     ro, hu, tr, vi, id, ms, sw, fil.  Roman-alphabet
//                     learners can read these directly.
//   romanize          Non-Latin alphabetic/abugida script.  Needs a
//                     phonetic line (5e).  Examples: ru, uk, th, hi,
//                     bn, ta, he, ar, fa, ur.
//   annotate-romanize CJK family (Han + Kana + Hangul).  Needs
//                     per-token readings (5d) plus full romanization
//                     (5e).  Examples: ja, ko, zh-Hans, zh-Hant, yue.
//   unsupported       Script we don't have a pipeline for.  Tracks
//                     with this classification are still ELIGIBLE as
//                     target — they render as raw text so the user
//                     still gets dual-subs out of the deal.  Examples:
//                     km, my, ka, hy.
//
// The classification is DERIVED from script, not enumerated by
// language.  Adding a new Latin-script language is automatic — no
// table edit.  Adding a new non-Latin script needs one line in
// SCRIPT_FAMILY below.  This is the load-bearing design choice that
// makes regional dialects (en-US / en-GB / pt-BR / pt-PT / es-419)
// fall out for free.

import { canonicalBaseLang, parseBcp47, resolveScript } from "./lang-code";

export type ScriptFamily =
  | "latin"
  | "cjk-han"
  | "kana"
  | "hangul"
  | "cyrillic"
  | "thai"
  | "lao"
  | "khmer"
  | "myanmar"
  | "tibetan"
  | "hebrew"
  | "arabic"
  | "indic"
  | "ethiopic"
  | "georgian"
  | "armenian"
  | "other";

export type Processing =
  | "native-display"
  | "romanize"
  | "annotate-romanize"
  | "unsupported";

export interface LangSupport {
  raw: string;
  base: string;
  script: string;
  family: ScriptFamily;
  processing: Processing;
  /** For CJK Han tracks only — which variant the user gets.  Drives
      the romanizer choice downstream (Pinyin / Zhuyin / Jyutping).
      null for non-Chinese languages. */
  chineseVariant: "simplified" | "traditional" | "cantonese" | null;
}

const SCRIPT_FAMILY: Record<string, ScriptFamily> = {
  Latn: "latin",
  Hans: "cjk-han",
  Hant: "cjk-han",
  Hani: "cjk-han",
  Jpan: "kana",
  Hira: "kana",
  Kana: "kana",
  Kore: "hangul",
  Hang: "hangul",
  Cyrl: "cyrillic",
  Thai: "thai",
  Laoo: "lao",
  Khmr: "khmer",
  Mymr: "myanmar",
  Tibt: "tibetan",
  Hebr: "hebrew",
  Arab: "arabic",
  Deva: "indic",
  Beng: "indic",
  Taml: "indic",
  Telu: "indic",
  Gujr: "indic",
  Guru: "indic",
  Knda: "indic",
  Mlym: "indic",
  Sinh: "indic",
  Orya: "indic",
  Ethi: "ethiopic",
  Geor: "georgian",
  Armn: "armenian",
};

const FAMILY_PROCESSING: Record<ScriptFamily, Processing> = {
  latin: "native-display",
  "cjk-han": "annotate-romanize",
  kana: "annotate-romanize",
  hangul: "annotate-romanize",
  cyrillic: "romanize",
  thai: "romanize",
  hebrew: "romanize",
  arabic: "romanize",
  indic: "romanize",
  // Scripts we render but don't yet romanize.  Promoted to "romanize"
  // as engine support lands (loom_core/romanize.py is the source of
  // truth for what's actually implemented).
  lao: "unsupported",
  khmer: "unsupported",
  myanmar: "unsupported",
  tibetan: "unsupported",
  ethiopic: "unsupported",
  georgian: "unsupported",
  armenian: "unsupported",
  other: "unsupported",
};

export function classifyLang(code: string): LangSupport {
  const parsed = parseBcp47(code);
  const base = canonicalBaseLang(code);
  const script = resolveScript(parsed);
  const family = SCRIPT_FAMILY[script] ?? "other";
  const processing = FAMILY_PROCESSING[family];

  let chineseVariant: LangSupport["chineseVariant"] = null;
  if (family === "cjk-han") {
    if (base === "yue" || base === "nan" || base === "hak") {
      // Topolect tags — these are spoken languages typically written
      // in Traditional Han.  Cantonese gets Jyutping (separate
      // romanizer); others fall through to traditional rendering.
      chineseVariant = base === "yue" ? "cantonese" : "traditional";
    } else if (script === "Hant") {
      chineseVariant = "traditional";
    } else {
      // Hans, Hani, or zh with no script (defaults to Hans).
      chineseVariant = "simplified";
    }
  }

  return {
    raw: code,
    base,
    script,
    family,
    processing,
    chineseVariant,
  };
}

// ---- Phonetic-system options (capability-driven picker) -------------
//
// `phonetic_system` is accepted end-to-end by /annotate/batch +
// /romanize/batch and drives the romanization LINE (and, for CJK, the
// ruby) — see loom_core/romanize.py for the authoritative per-language
// system lists this table mirrors.  Only languages with MORE THAN ONE
// system need a picker; everything else (Korean, Cyrillic, Indic,
// Hebrew, Japanese) has a single system and returns [] so the UI shows
// no choice.  Japanese long-vowel mode is a separate control.

export interface PhoneticSystemOption {
  code: string;
  label: string;
}

const CHINESE_SYSTEMS: PhoneticSystemOption[] = [
  { code: "pinyin", label: "Pinyin" },
  { code: "zhuyin", label: "Zhuyin (Bopomofo)" },
  { code: "jyutping", label: "Jyutping (Cantonese)" },
];
const THAI_SYSTEMS: PhoneticSystemOption[] = [
  { code: "paiboon", label: "Paiboon+ (with tones)" },
  { code: "rtgs", label: "RTGS (ASCII)" },
  { code: "ipa", label: "IPA" },
];
const ARABIC_SYSTEMS: PhoneticSystemOption[] = [
  { code: "learner", label: "Learner" },
  { code: "din", label: "DIN 31635 (scholarly)" },
  { code: "loose", label: "Loose (ASCII)" },
];
const PERSIAN_SYSTEMS: PhoneticSystemOption[] = [
  { code: "learner", label: "Learner" },
  { code: "dmg", label: "DMG (scholarly)" },
];
const URDU_SYSTEMS: PhoneticSystemOption[] = [
  { code: "learner", label: "Learner (Hunterian)" },
  { code: "ala-lc", label: "ALA-LC (scholarly)" },
];

/** Phonetic-system choices for a language, or [] when there's only one
    (or none) — in which case the UI surfaces no picker.  Arabic-script
    languages branch on base lang (ar / fa / ur each have distinct
    systems); CJK-Han covers all Chinese variants (Japanese is `kana`
    family, Korean `hangul`, so both correctly fall through to []). */
export function phoneticSystemsFor(code: string): PhoneticSystemOption[] {
  const cls = classifyLang(code);
  if (cls.family === "cjk-han") return CHINESE_SYSTEMS;
  if (cls.family === "thai") return THAI_SYSTEMS;
  if (cls.family === "arabic") {
    if (cls.base === "fa" || cls.base === "prs") return PERSIAN_SYSTEMS;
    if (cls.base === "ur") return URDU_SYSTEMS;
    return ARABIC_SYSTEMS;
  }
  return [];
}

/** A learner-friendly label for the phonetic-system picker, named per
    language instead of the generic "phonetic system".  Mirrors the
    branches of phoneticSystemsFor(); only called where that returns ≥2
    systems, so the [] fallback is defensive. */
export function phoneticSystemLabelFor(code: string): string {
  const cls = classifyLang(code);
  if (cls.family === "cjk-han") return "Chinese reading (Pinyin / Zhuyin / Jyutping)";
  if (cls.family === "thai") return "Thai romanization (Paiboon / RTGS / IPA)";
  if (cls.family === "arabic") {
    if (cls.base === "fa" || cls.base === "prs") return "Persian transliteration";
    if (cls.base === "ur") return "Urdu transliteration";
    return "Arabic transliteration";
  }
  return "Romanization style";
}

// ---- Language-aware target defaults ---------------------------------
//
// Sensible per-language defaults for the two target controls, applied by
// discover.ts only when the user hasn't explicitly overridden them.

/** Default ON/OFF for the secondary full-utterance romanization LINE,
    by target language.
    - Pure-`romanize` scripts (Cyrillic / Thai / Indic / Hebrew / Arabic):
      ON — the line is their ENTIRE phonetic surface.
    - CJK + Korean (`annotate-romanize`): these already get per-token ruby
      (Pinyin / Bopomofo / Jyutping / Hangul RR), so a second line is
      redundant — EXCEPT Japanese, whose ruby is kana (furigana), not a
      romanization, so the romaji line genuinely adds reading help.  Hence
      only Japanese (the `kana` family) defaults ON.
    - Anything else has no phonetic layer, so the value is moot (OFF). */
export function defaultRomanizeLineEnabledFor(code: string): boolean {
  const cls = classifyLang(code);
  if (cls.processing === "romanize") return true;
  if (cls.processing === "annotate-romanize") return cls.family === "kana";
  return false;
}

/** Default phonetic SYSTEM by target language (null = let the backend
    pick its own default).  Chinese defaults to Pinyin for BOTH Simplified
    and Traditional — Bopomofo/Zhuyin is opt-in; Pinyin is the modern
    lingua franca.  Cantonese gets Jyutping (Pinyin doesn't apply).
    Everything else falls through to null. */
export function defaultPhoneticSystemFor(code: string): string | null {
  const cls = classifyLang(code);
  if (cls.chineseVariant === "cantonese") return "jyutping";
  if (cls.family === "cjk-han") return "pinyin";
  return null;
}

/** Two BCP-47 codes share a base language.  Used for regional-variant
    collapse: en + en-US + en-GB + en-AU + en-IN are all "English";
    pt + pt-BR + pt-PT are all "Portuguese"; es + es-MX + es-419 +
    es-ES are all "Spanish".  Deprecated codes are canonicalized
    (iw→he, in→id, ji→yi).

    NOTE: zh and yue are intentionally treated as DIFFERENT base langs
    even though both are "Chinese" colloquially — they're separate ISO
    639 languages, and the romanizer choice differs (Pinyin vs Jyutping).
    Use chineseVariant from classifyLang() if you need to unify them. */
export function sameBaseLang(a: string, b: string): boolean {
  const A = canonicalBaseLang(a);
  const B = canonicalBaseLang(b);
  if (!A || !B) return false;
  return A === B;
}
