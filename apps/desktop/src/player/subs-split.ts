// Script-based language splitting for external subtitle files.
//
// Anime commonly ships EXTERNAL subs as bilingual .ass files — e.g. the
// DBD-Raws Frieren `.scjp.ass` interleaves Japanese (Dial_JP) and
// Simplified-Chinese (Dial_CH) dialogue in ONE file.  Loom wants clean
// single-language tracks (a JA target for furigana/romaji, a ZH track,
// etc.), so we split a file's events by the DOMINANT SCRIPT of each cue:
//
//   - any kana (hiragana/katakana) → Japanese  ("ja")
//   - Han only, no kana            → Chinese    ("zh")  [Hans/Hant from the
//                                                        filename hint later]
//   - Hangul                       → Korean     ("ko")
//   - mostly Latin                 → English    ("en")  [best-effort]
//
// A monolingual file just yields one bucket — harmless.  This is a
// heuristic (a bilingual line with both scripts lands in JA, which is the
// learner's target anyway), not a full style parser; good enough to make
// real anime subs load.  Simplified-vs-Traditional is NOT decided per line
// (unreliable on shared Han) — the caller sets it from the filename hint.

import type { CaptionEvent } from "@loom/player-ui/captions/types";

const KANA = /[぀-ゟ゠-ヿ]/;
const HAN = /[一-鿿㐀-䶿]/;
const HANGUL = /[가-힣ᄀ-ᇿ]/;
const LATIN = /[A-Za-z]/;

export type SplitLang = "ja" | "zh" | "ko" | "en" | "other";

export function classifyLine(text: string): SplitLang {
  const t = text.replace(/\s+/g, "");
  if (!t) return "other";
  if (KANA.test(t)) return "ja";
  if (HANGUL.test(t)) return "ko";
  if (HAN.test(t)) return "zh";
  // Latin-dominant → English.
  const latin = (t.match(new RegExp(LATIN, "g")) ?? []).length;
  if (latin >= t.length * 0.5) return "en";
  return "other";
}

export interface LangBucket {
  lang: SplitLang;
  events: CaptionEvent[];
}

/** Group events into per-language buckets by script.  Buckets with too few
    events (noise / stray signs) are dropped.  Returned largest-first. */
export function splitEventsByLanguage(events: CaptionEvent[]): LangBucket[] {
  const buckets = new Map<SplitLang, CaptionEvent[]>();
  for (const e of events) {
    const lang = classifyLine(e.text);
    if (lang === "other") continue;
    const arr = buckets.get(lang) ?? [];
    arr.push(e);
    buckets.set(lang, arr);
  }
  const total = events.length || 1;
  return [...buckets.entries()]
    .map(([lang, evs]) => ({ lang, events: evs }))
    // Drop tiny buckets (< 8% of cues AND < 10 events) — cross-script noise
    // (a stray sign, romanized name) shouldn't fabricate a whole track.
    .filter((b) => b.events.length >= 10 || b.events.length / total >= 0.08)
    .sort((a, b) => b.events.length - a.events.length);
}
