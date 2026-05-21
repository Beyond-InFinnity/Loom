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
