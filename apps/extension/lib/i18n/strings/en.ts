// Canonical UI string table — the single source of truth for every key.  Each
// locale file is a Partial of this; any key it omits falls back to the English
// here.  `{name}` tokens are interpolated by t(key, params).
//
// SCOPE: chrome only (buttons, labels, hints, status).  Proper nouns that are
// identical across languages stay as literals in the components and are NOT
// keyed here: platform names (YouTube/Netflix/…), romanization system names
// (Pinyin/Zhuyin/Jyutping/Romaji/IPA/RTGS/DIN 31635/ALA-LC/DMG/Hunterian),
// font family names, and the wordmark "Loom".  Language display names come from
// Intl.DisplayNames via languageName(), never from this table.
export const en = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Dual subs for foreign-language video.",
  "popup.enableLabel": "Loom on this browser",
  "popup.turnOff": "Turn Loom off",
  "popup.turnOn": "Turn Loom on",
  "popup.statusOn": "ON — Loom appears automatically on compatible videos.",
  "popup.statusOff": "OFF — Loom runs nowhere until you turn it back on.",
  "popup.checkApi": "Check API",
  "popup.checking": "Checking…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Error: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Learn languages from the shows you already watch.",
  "onboarding.step1.title": "Open a video",
  "onboarding.step1.body":
    "Loom works on {platforms} — any video with subtitles in the language you're learning.",
  "onboarding.step2.title": "Click the Loom pill",
  "onboarding.step2.body":
    "A small {pill} pill appears in the player. Click it to activate — each tab stays off until you ask.",
  "onboarding.step3.title": "Read all four layers",
  "onboarding.step3.body":
    "Your language, the video's language, a phonetic line, and per-character readings (furigana, Pinyin, and more). The ⚙ panel on the pill customizes everything.",
  "onboarding.help.title": "Help improve Loom?",
  "onboarding.help.body":
    "Contribute anonymous caption data: the videos you watch share their video ID and subtitle text with Loom's training corpus to improve annotations, romanization, and future OCR support. It's never linked to you — no account, no IP address, no identifiers — and identical content is stored only once no matter how many people watch it.",
  "onboarding.help.contribute": "Contribute caption data",
  "onboarding.help.decline": "No thanks",
  "onboarding.help.thanks": "Thank you! You're contributing caption data.",
  "onboarding.help.noProblem": "No problem — nothing will be shared.",
  "onboarding.help.changeLater":
    "You can change this anytime in the Loom pill's ⚙ settings panel.",
  "onboarding.privacyPolicy": "Privacy policy",
  "onboarding.helpFaq": "Help & FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom settings",
  "pill.discovering": "discovering…",
  "pill.noCaptions": "no captions",
  "pill.noSupportedTracks": "no supported tracks",
  "pill.error": "error (see console)",
  "dormant.activate": "Activate Loom on this tab",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Help improve Loom?",
  "consent.body":
    "Contribute anonymous caption data (video ID + subtitle text — never anything about you) to improve annotations and romanization.",
  "consent.contribute": "Contribute",
  "consent.decline": "No thanks",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Definition of {word}",
  "define.looking": "Looking up…",
  "define.unreachable": "Couldn't reach the dictionary.",
  "define.noEntry": "No dictionary entry.",
  "define.breakdown": "Breakdown",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (Default)",
  "preset.loominate.desc": "Loom's default pastel colors.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Support Loom",
  "settings.title": "Loom settings",
  "settings.close": "Close settings",
  "settings.feedback": "Send feedback",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "User language (auto-pick base)",
  "settings.userLang.hint":
    "Auto-pick matches any regional variant (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Video language (Top) — {count} tracks",
  "settings.bottomLang.title": "User language (Bottom)",
  "settings.bottomLang.autoTranslate":
    "(auto: translate to {lang} when no matching track)",
  "settings.bottomLang.noAutoTranslate":
    "(none — no auto-translation on {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Position",
  "settings.videoLang": "Video language",
  "settings.userLang": "User language",
  "settings.position.hint":
    "Slot 1 = upper line in its zone, slot 2 = lower. Solo in a zone uses the zone's default position.",
  "settings.position.topNudge": "Top line — vertical nudge",
  "settings.position.bottomNudge": "Bottom line — vertical nudge",
  "settings.position.lineSpacing": "Line spacing",
  "settings.position.nudgeHint":
    "Nudge moves a line toward the picture center as you raise it (down for the top line, up for the bottom) — handy for pulling text off the black bars on letterboxed video. Signs and vertical cues keep their own position. Saved per platform.",
  "settings.pos.top1": "↑ Top 1",
  "settings.pos.top2": "↑ Top 2",
  "settings.pos.bot1": "↓ Bot 1",
  "settings.pos.bot2": "↓ Bot 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Subtitle size",
  "settings.size.overall": "Overall size",
  "settings.size.hint":
    "Scales every line together, on top of the per-line sizes below. 100% matches the tuned default; drop it if the subtitles render large here (e.g. Netflix in fullscreen). Remembered separately for each platform.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Color presets",
  "settings.preset.label": "Preset",
  "settings.preset.custom": "(custom)",
  "settings.preset.noPreset": "(no preset — custom colors)",
  "settings.preset.loading": "Loading presets…",
  "settings.preset.none":
    "No presets available — switch to a Chinese, Japanese, Korean, Thai, or Russian track to see language-themed presets, or use Classic on any track.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Bottom — user language",
  "settings.layer.showBottom": "Show Bottom line",
  "settings.layer.top": "Top — video language",
  "settings.layer.showTop": "Show Top line",
  "settings.layer.linkOpacity":
    "Link opacity (annotation, romanization, alt-spelling)",
  "settings.layer.linkOpacityAria": "Link Top group opacity",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Per-character annotation",
  "settings.annotation.userLangAdvanced": "User-language annotation",
  "settings.annotation.hint":
    "Small readings above each character — furigana for Japanese, Pinyin / Zhuyin / Jyutping for Chinese, Romanization for Korean. Available for Chinese, Japanese, and Korean. Size is a fraction of the Top line (0.5 = half).",
  "settings.annotate.none": "No per-character annotation for this language yet.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Romanization (phonetic line)",
  "settings.romanization.userLangAdvanced": "User-language romanization",
  "settings.romanization.hint":
    "A full pronunciation line above the video's text. Available for Chinese, Japanese, Korean, Cyrillic, Thai, Indic, Hebrew, and Arabic / Persian / Urdu scripts. The style picker appears only where there's more than one option. Size is a fraction of the parent line.",
  "settings.romanize.style": "Romanization style",
  "settings.romanize.auto": "Auto (default for language)",
  "settings.romanize.none":
    "No pronunciation line for this language (Latin script or unsupported).",
  "settings.chooseTrack": "(choose a track above first)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Japanese long vowels",
  "settings.longVowel.macrons": "Macrons (tōkyō)",
  "settings.longVowel.doubled": "Doubled vowels (tookyoo)",
  "settings.longVowel.unmarked": "Unmarked (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Data",
  "settings.data.contribute": "Contribute caption data",
  "settings.data.hint":
    "Sends the subtitles of videos you watch (video title/ID and caption text — never anything about you) to Loom's training corpus to improve annotations, romanization, and future OCR support.",
  "settings.turnOff": "Turn off Loom on this tab",
  "settings.turnOff.hint":
    "Reactivate via the small pill that returns when you turn it off. Persists across reloads of this tab.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "This title's subtitles are images, not text, so Loom can't read them. Try a title with text-based subtitles.",
  "settings.empty.noTracks": "No supported subtitle tracks on this video.",
  "settings.empty.discovering": "Discovering subtitles…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Translate to",
  "settings.noTranslation": "(no translation)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "manual",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Color",
  "settings.font": "Font",
  "settings.sizePx": "Size (px)",
  "settings.sizeRatio": "Size (ratio of Top)",
  "settings.opacity": "Opacity",
  "settings.advanced": "Advanced",
  "settings.outlineColor": "Outline color",
  "settings.outlineAlpha": "Outline alpha",
  "settings.glowRadius": "Glow radius (px)",
  "settings.glowNone": "0 = no glow",
  "settings.glowHalo": "{n}px halo",
  "settings.glowColor": "Glow color",
  "settings.glowAlpha": "Glow alpha",
  "settings.colorWheel": "Open color wheel",
  "settings.setColor": "Set color to {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + system fallback)",
  "settings.font.systemSans": "System sans-serif",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "no romanization",
  "settings.proc.latinNone": "Latin (no romanization)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Alternate orthography",
  "settings.variant.highlightColors": "Highlight & colors",
  "settings.variant.colorCode": "Color-code differing chars",
  "settings.variant.simpSameAsTop": "Simplified char: same as Top",
  "settings.variant.simpColor": "Simplified char color",
  "settings.variant.matchesTop": "matches Top",
  "settings.variant.distinctColor": "Distinct char color",
  "settings.variant.mergedColor": "Merged char color",
  "settings.variant.preview": "Preview",
  "settings.variant.distinct": "Distinct",
  "settings.variant.merged": "Merged",
  // The bold "Distinct:" / "Merged:" labels reuse settings.variant.distinct /
  // .merged; these are the sentences that follow each label (no leading label).
  "settings.variant.distinctHint":
    "the Traditional char has its own unique Simplified form (語 → 语). Someone reading the Simplified could tell which Traditional was meant.",
  "settings.variant.mergedHint":
    "several Traditional chars share the same Simplified form (髮 and 發 both → 发). The original is lost — that's where simplification throws away information.",
  // Rendered after a "{languageCode}: " prefix, so lowercase and prefix-less.
  "settings.variant.none":
    "no orthography variant in this build. Today only Traditional Chinese (zh-Hant / zh-TW / zh-HK / zh-MO / yue) is supported.",
} as const satisfies Record<string, string>;

export type StringKey = keyof typeof en;

// A locale table need only override the keys it translates; any missing key
// falls back to the canonical English string above, so a partial translation is
// safe to ship (English shows through the gaps rather than a raw key).
export type LocaleTable = Partial<Record<StringKey, string>>;
