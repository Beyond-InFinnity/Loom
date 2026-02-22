# SRTStitcher

A subtitle merging and language-learning tool. Load a video with multiple subtitle tracks, stitch them together into a single `.ass` file, and get phonetic annotations — pinyin above hanzi, furigana above kanji, romaji above Japanese — displayed character-by-character, the way Duolingo renders it, but for any video you own.

The goal is to make the experience of watching foreign-language content with phonetic support feel native and readable, rather than forcing you to switch between a subtitle track and a lookup tab.

---

## What It Does

SRTStitcher takes two subtitle tracks — typically a target language and your native language — and combines them into a single layered `.ass` subtitle file. For supported scripts, it generates phonetic annotation aligned above each character or word compound.

**The four-layer output for Japanese content:**

```
eren chōsa heidan ni iri taitte kimochi ha kawatta ?    ← romaji (with macrons)
ちょうさへいだん    いり    きもち    かわ               ← furigana
エレン 調査兵団に 入りたいって 気持ちは 変わった？        ← Japanese
Eren, did that change your mind about joining the Survey Corps?  ← English
```

The layer ordering follows interlinear gloss convention — the standard format used in linguistic analysis — progressing from most phonetically accessible (romaji) down to the native script, with the translation at the bottom. Romaji above furigana above Japanese: the same mental model as Duolingo's pinyin display, extended to a full four-layer stack.

---

## Annotation Quality

### Japanese Furigana — Three-Tier Sourcing

The furigana layer uses a priority sourcing system:

**1. Author-annotated readings (ground truth).** Quality fansub files often contain inline readings written directly into the dialogue text — a convention where the subtitle author annotates a hard kanji with its reading in parentheses immediately after: `奴(やつ)`. SRTStitcher detects this pattern and uses the author's reading in preference to anything generated. The person who wrote the subtitle knew the correct reading for that specific line in context — that's better than any automated system, especially for unusual readings, character names, and readings that depend on narrative context.

The detection exploits a reserved Japanese typographic convention: hiragana-only content in parentheses immediately adjacent to kanji has essentially one meaning in Japanese writing. The false positive rate for subtitle content is effectively zero.

**2. Pre-existing ASS ruby annotations.** If the source track already contains positioned furigana events, SRTStitcher detects them and defers to them rather than regenerating.

**3. pykakasi fallback.** For everything else, pykakasi provides morpheme-level tokenization and hiragana readings.

### Japanese Romaji — Resolved Kana Pipeline

Romaji is generated from resolved kana rather than raw mixed text. The pipeline: extract author-annotated readings → pykakasi fills gaps → merge (author readings take priority) → pure kana string → deterministic kana→romaji lookup. This produces more accurate romaji than passing raw text directly to pykakasi, particularly for unusual vocabulary and character names.

**Long vowel modes** (selectable per session):
- **Macrons** (default): Tōkyō, gakkō, kōhī — standard in dictionaries and linguistics
- **Doubled**: Toukyou, gakkou, koohii — unambiguous ASCII, useful for IME input practice
- **Unmarked**: Tokyo, gakko, kohi — most familiar to general audiences

Note: `ei` sequences are intentionally not macronized — strict Hepburn convention (先生 → *sensei*, not *sensē*).

---

## Romanization Confidence

Not all romanization is created equal. SRTStitcher assigns a confidence level to each language's phonetic output, displayed in the UI:

| Confidence | Languages | Why |
|-----------|-----------|-----|
| 🟢 Very High | Chinese/Pinyin | 1:1 character mapping, fully standardized phonetic system |
| 🟢 High | Korean, Russian, Ukrainian, Cyrillic variants | Rule-based transliteration with well-defined standards |
| 🟡 Good | Japanese (pykakasi), Thai | Reliable for common vocabulary; occasional context-dependent errors |
| 🟡 Moderate | Hindi and Indic scripts | Reliable transliteration but multiple valid romanization schemes exist |
| 🟠 Low (opt-in) | Arabic, Persian, Urdu | Abjad scripts omit short vowels — romanization is inherently incomplete. Off by default. |

Chinese pinyin is essentially perfect — it's a standardized phonetic alphabet, not a heuristic. Arabic romanization is fundamentally limited by the writing system itself.

---

## Current State

The core pipeline is working end-to-end:

**MKV scan → track extraction → language detection → style configuration → composite preview → `.ass` generation → remux**

| Language | Annotation | Status |
|----------|-----------|--------|
| Chinese (Simplified + Traditional) | Pinyin with tone marks | ✅ Block output — per-character alignment in progress (R2b) |
| Japanese | Furigana (character-aligned) + Hepburn romaji with long vowel modes | ✅ Full four-layer output |
| English | — | ✅ |
| Korean, Thai, Cyrillic languages | Romanization | 🔲 Next (R4) |
| Cantonese | Jyutping | 🔲 Planned (R2c) |
| Hindi/Indic, Arabic/Persian/Urdu | Romanization | 🔲 Planned (R5) |

### Chinese Variant Handling (R2c — designed, not yet implemented)

The three Chinese variants receive different treatment based on detected script and language:

| Variant | Detection | Phonetic annotation | Default |
|---------|-----------|-------------------|---------|
| Simplified Mandarin | `zh-Hans`, `zh-CN`, `chs` tag | Pinyin | Pinyin |
| Traditional Mandarin | `zh-Hant`, `zh-TW`, `cht` tag + no Cantonese markers | Zhuyin (Bopomofo) or Pinyin | Zhuyin |
| Cantonese | `zh-yue`/`yue` tag, or Cantonese character markers (係/喺/囉/咁/嘅) | Jyutping | Jyutping |

Zhuyin is the default for Traditional Chinese because Taiwan uses Zhuyin Fuhao as its primary phonetic literacy system — pinyin is a 1958 mainland standardization. Script conversion between Simplified and Traditional (both directions, with Taiwan-standard vocabulary) is also planned via `opencc`.

---

## Why This Exists

Learning a language through media is one of the most effective and enjoyable ways to build comprehension — but the tooling has always been fragmented. You either watch with subtitles in your target language and miss content when you hit unknown vocabulary, or you watch with native-language subtitles and lose the immersion. Tools like Duolingo nail the phonetic annotation UX but only work within their own controlled content environment.

SRTStitcher is an attempt to bring that UX to any video you watch. The immediate use case is anime with Japanese and Chinese fansub tracks, but the architecture is designed to generalize to any script where phonetic annotation is meaningful for learners — Devanagari, Thai, Hangul, Cantonese, and others.

The longer-term goal is a browser extension that works on YouTube, Netflix, and other streaming platforms. The local desktop tool is the prototype that proves the pipeline.

---

## How Is This Different From Aegisub / SubSync / Alass?

Those tools align, edit, or synchronize subtitles — they solve the problem of getting subtitle timing right. SRTStitcher solves a different problem: merging two subtitle tracks into a single layered file with phonetic annotation. No existing subtitle tool takes a Japanese track and an English track and produces a four-layer output with furigana above kanji and romaji above that. The annotation pipeline — three-tier furigana sourcing, per-script romanization with confidence scoring, inline reading detection — is the core of what SRTStitcher does, and it's not something you can get by combining existing tools.

---

## Tech Stack

- **Python** — core processing
- **Streamlit** — local web UI
- **ffmpeg** — MKV scan, track extraction, remux
- **pykakasi** — Japanese tokenization, furigana readings, kana pipeline
- **pypinyin** — Chinese pinyin with tone marks (and Zhuyin via `Style.BOPOMOFO`)
- **pycantonese** — Cantonese Jyutping romanization *(planned R2c)*
- **opencc-python-reimplemented** — Simplified ↔ Traditional Chinese script conversion *(planned R2c)*
- **pysubs2** — `.ass` subtitle manipulation
- **cyrtranslit**, **korean-romanizer**, **pythainlp** — Cyrillic, Korean, Thai romanization *(planned R4)*

Subtitle input formats supported: `.srt`, `.ass`, `.ssa`, `.vtt`, `.sub`, `.sbv`, `.idx`, `.ttml`, `.dfxp`, `.stl`, `.smi` — detected by content, not extension.

---

## Project Structure

```
srt_stitcher_app.py     # Streamlit entry point
app/
  mkv_handler.py        # MKV scan, extraction, remux — all ffmpeg calls live here
  romanize.py           # Phonetic annotation module (romanizers + annotation spans)
  processing.py         # .ass event generation, \pos() stacking, annotation layout
  preview.py            # HTML composite preview with CSS ruby rendering
  language.py           # Language detection
  styles.py             # Per-language style configuration factory
  state.py              # Streamlit session state
  ui.py                 # UI helpers
requirements.txt
CLAUDE.md               # Developer context and architecture notes
```

---

## Running Locally

```bash
pip install -r requirements.txt
streamlit run srt_stitcher_app.py
```

ffmpeg must be installed and available on your PATH.

**CJK font note:** For correct rendering of Japanese, Chinese, and Korean subtitles (both in the preview and in VLC/media players), you'll want CJK-capable fonts installed on your system. The [Noto CJK](https://fonts.google.com/noto#702) family (Noto Sans JP, Noto Sans SC, Noto Sans KR) is recommended — they're free, high quality, and cover all three scripts. SRTStitcher defaults to these fonts for CJK tracks. If they're not installed, subtitle text may render as empty boxes in the preview or in your media player.

---

## Architecture Notes

**Annotation infrastructure is language-agnostic.** The `\pos()` stacking system that places furigana above kanji compounds is a generic span renderer — `(original_text, annotation)` pairs in, positioned ASS events out. Adding phonetic annotation for a new script means implementing a new data source; the rendering layer doesn't change. The same infrastructure that renders furigana above Japanese renders pinyin above individual hanzi characters, and will render Zhuyin, Jyutping, akshara readings above Devanagari, and syllable readings above Thai.

**Layer ordering follows interlinear gloss convention.** The decision to place romaji above furigana above Japanese is intentional. In linguistic interlinear gloss format, phonetic transcription sits above the intermediate annotation which sits above the base text. For a language-learning context, this progression from most accessible to most native is the right mental model — and it means the furigana sits directly above the kanji it annotates, which is where it belongs typographically.

**Language detection runs a character-level override before probabilistic detection.** For Cyrillic scripts, certain characters are definitively diagnostic: ї, є, ґ only exist in Ukrainian Cyrillic; ў only exists in Belarusian. For Chinese, Cantonese-specific characters (係, 喺, 囉, 咁, 嘅) distinguish Cantonese from Mandarin with high confidence. In both cases, detecting these characters in source text identifies the language before any probabilistic model is consulted. This matters because misclassification doesn't just produce wrong output — it produces output under the wrong standard. SRTStitcher treats Ukrainian and Russian as the different languages they are, and treats Cantonese as distinct from Mandarin.

**Inline furigana in source subtitle files is treated as ground truth.** Fansub authors often annotate hard kanji readings directly in the dialogue text as `奴(やつ)`. SRTStitcher detects this pattern, extracts the author-provided reading, and uses it in preference to generated readings. The same detection strips the parenthetical before passing text to pykakasi, preventing doubled romanization output.

**No large files are loaded into RAM.** Video files are always handled as local paths passed to ffmpeg subprocesses. An 84GB 4K MKV and a 450MB MKV consume the same memory during processing.

---

## Test Data

**Primary test content:** Attack on Titan MKV releases — contains Taiwan Traditional Chinese, CantoCaptions (Cantonese), Japanese, and English subtitle tracks in a single file. Courtesy of [Furretar](https://github.com/Furretar) and the [Mandarin Subtitles Archive](https://github.com/Furretar/Mandarin-Subtitles-Archive).

**Additional test corpus:**
- *Three-Body Problem* (Tencent, 2023) — Simplified Chinese, technical and formal Mandarin vocabulary
- *Seven Samurai* (1954, Criterion 4K) — Japanese classical and archaic vocabulary; Traditional Chinese (negative test for Cantonese discriminator); European subtitle tracks; image-based PGS tracks for future OCR pipeline work
- *Inuyasha* (DVD fansub) — older subtitle encoding styles, legacy formatting

---

## Status and Roadmap

This is an actively developed prototype. The pipeline is stable and the Japanese annotation layers (furigana + romaji) are working. Chinese pinyin block output is working; per-character alignment is in progress.

Planned work in rough order:

1. Per-character pinyin alignment for Chinese + generalized annotation system rename (R2b — in progress)
2. Chinese variant handling: Zhuyin for Traditional Mandarin, Jyutping for Cantonese, Simplified ↔ Traditional script conversion (R2c)
3. Korean, Thai, Cyrillic romanization (R4)
4. Indic scripts — Hindi, Bengali, Tamil, Telugu (R5)
5. Color pickers and font validation UI (R6)
6. Browser extension

---

## Development Process

Architecture decisions for this project go through a review step before implementation — complex design questions (library selection across 20+ scripts, Cyrillic language discrimination, furigana rendering strategy, Chinese variant handling) are drafted as structured briefs and reviewed by a more capable model before being handed to Claude Code for implementation. This keeps implementation fast and design sound. `CLAUDE.md` in the repo root contains the full architecture context and is kept current as a living document.

---

*Built for language learners, by someone learning languages.*
