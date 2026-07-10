import type { LocaleTable } from "./en";

// Cantonese (粵語 / 廣東話, Hong Kong colloquial, Traditional script) UI strings. Keys and {param} placeholders match en.ts.
export const yue: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "睇外語片嘅雙語字幕。",
  "popup.enableLabel": "喺呢個瀏覽器開 Loom",
  "popup.turnOff": "熄咗 Loom",
  "popup.turnOn": "開 Loom",
  "popup.statusOn": "開咗 —— Loom 會喺啱使嘅片度自動彈出嚟。",
  "popup.statusOff": "熄咗 —— 你唔開返之前 Loom 邊度都唔會行。",
  "popup.checkApi": "查 API",
  "popup.checking": "查緊…",
  "popup.apiHost": "API：{host}",
  "popup.httpStatus": "HTTP {status}：{body}",
  "popup.error": "出錯：{message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "睇你平時追開嘅劇順便學語言。",
  "onboarding.step1.title": "開一條片",
  "onboarding.step1.body":
    "Loom 喺 {platforms} 都用得 —— 任何一條有你學緊嗰種語言字幕嘅片都得。",
  "onboarding.step2.title": "撳一下 Loom 個掣",
  "onboarding.step2.body":
    "播放器度會有粒細細嘅 {pill} 掣。撳一下就啟動到 —— 你唔叫佢，每個分頁都會維持熄住。",
  "onboarding.step3.title": "四層嘢一齊睇",
  "onboarding.step3.body":
    "你嘅語言、條片嘅語言、一行拼音，仲有逐個字嘅讀音（furigana、Pinyin 等等）。個掣上面粒 ⚙ 面板乜都改得。",
  "onboarding.help.title": "幫手令 Loom 更好？",
  "onboarding.help.body":
    "貢獻匿名字幕資料：你睇嘅片會將佢個 video ID 同字幕文字分享畀 Loom 嘅訓練語料庫，等我哋改善注音、羅馬拼音同將來嘅 OCR 支援。呢啲嘢永遠都唔會同你扯上關係 —— 冇帳戶、冇 IP 位址、冇任何識別碼 —— 而且無論幾多人睇同一段內容，都只係存一次。",
  "onboarding.help.contribute": "貢獻字幕資料",
  "onboarding.help.decline": "唔使喇",
  "onboarding.help.thanks": "多謝晒！你而家貢獻緊字幕資料。",
  "onboarding.help.noProblem": "冇問題 —— 咩都唔會分享。",
  "onboarding.help.changeLater":
    "你隨時都可以喺 Loom 個掣嘅 ⚙ 設定面板度改返。",
  "onboarding.privacyPolicy": "私隱政策",
  "onboarding.helpFaq": "說明同常見問題",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom 設定",
  "pill.discovering": "搵緊…",
  "pill.noCaptions": "冇字幕",
  "pill.noSupportedTracks": "冇支援到嘅字幕軌",
  "pill.error": "出錯（睇下 console）",
  "dormant.activate": "喺呢個分頁啟動 Loom",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "幫手令 Loom 更好？",
  "consent.body":
    "貢獻匿名字幕資料（video ID + 字幕文字 —— 永遠都唔會有關於你嘅嘢），等我哋改善注音同羅馬拼音。",
  "consent.contribute": "貢獻",
  "consent.decline": "唔使喇",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "{word} 嘅解釋",
  "define.looking": "查緊…",
  "define.unreachable": "連唔到字典。",
  "define.noEntry": "冇呢個字典解釋。",
  "define.breakdown": "拆解",
  "define.grammar": "文法",
  "define.glossLanguage": "詞典語言",
  "define.glossAuto": "自動",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate（預設）",
  "preset.loominate.desc": "Loom 預設嘅柔和顏色。",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "支持 Loom",
  "settings.title": "Loom 設定",
  "settings.close": "閂設定",
  "settings.feedback": "畀意見",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "使用者語言（自動揀嘅基準）",
  "settings.userLang.hint":
    "自動揀會夾任何地區變體（en → en-US、en-GB、en-AU…）。",
  "settings.videoLang.title": "影片語言（上面）—— {count} 條字幕軌",
  "settings.bottomLang.title": "使用者語言（下面）",
  "settings.bottomLang.autoTranslate":
    "（自動：冇夾到嘅字幕軌就譯做 {lang}）",
  "settings.bottomLang.noAutoTranslate":
    "（冇 —— {platform} 度冇自動翻譯）",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "位置",
  "settings.videoLang": "影片語言",
  "settings.userLang": "使用者語言",
  "settings.position.hint":
    "位 1 = 所在區域上面嗰行，位 2 = 下面嗰行。區域入面淨返一行嘅話就用嗰個區域嘅預設位置。",
  "settings.position.topNudge": "上面嗰行 —— 上下微調",
  "settings.position.bottomNudge": "下面嗰行 —— 上下微調",
  "settings.position.lineSpacing": "行距",
  "settings.position.nudgeHint":
    "微調會喺你調高數值時將嗰行移向畫面中間（上面行向下，下面行向上）—— 用嚟將文字拉離黑邊片嘅黑邊就好方便。招牌同直排字幕會保持返自己嘅位置。逐個平台分開儲。",
  "settings.pos.top1": "↑ 上 1",
  "settings.pos.top2": "↑ 上 2",
  "settings.pos.bot1": "↓ 下 1",
  "settings.pos.bot2": "↓ 下 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "字幕大細",
  "settings.size.overall": "整體大細",
  "settings.size.hint":
    "喺下面每行各自嘅大細之上，將所有行一齊縮放。100% 係調校好嘅預設值；如果字幕喺度睇落太大（例如全螢幕嘅 Netflix），可以調細啲。逐個平台分開記住。",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "顏色預設",
  "settings.preset.label": "預設",
  "settings.preset.custom": "（自訂）",
  "settings.preset.noPreset": "（冇預設 —— 自訂顏色）",
  "settings.preset.loading": "載入緊預設…",
  "settings.preset.none":
    "而家冇預設用 —— 轉去中文、日文、韓文、泰文或者俄文字幕軌就見到相應語言主題嘅預設，或者喺任何字幕軌用 Classic。",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "下面 —— 使用者語言",
  "settings.layer.showBottom": "顯示下面嗰行",
  "settings.layer.top": "上面 —— 影片語言",
  "settings.layer.showTop": "顯示上面嗰行",
  "settings.layer.linkOpacity":
    "連埋不透明度（注音、羅馬拼音、異體字）",
  "settings.layer.linkOpacityAria": "連埋上面組嘅不透明度",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "逐個字注音",
  "settings.annotation.userLangAdvanced": "使用者語言注音",
  "settings.annotation.hint":
    "每個字上面嘅細細讀音 —— 日文係 furigana，中文係 Pinyin / Zhuyin / Jyutping，韓文係羅馬拼音。中文、日文同韓文都用得。大細係上面嗰行嘅比例（0.5 = 一半）。",
  "settings.annotate.none": "呢種語言暫時未有逐個字注音。",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "羅馬拼音（讀音行）",
  "settings.romanization.userLangAdvanced": "使用者語言羅馬拼音",
  "settings.romanization.hint":
    "影片文字上面嘅完整讀音行。中文、日文、韓文、西里爾文、泰文、印度系文字、希伯來文同阿拉伯文 / 波斯文 / 烏爾都文都用得。淨係有多過一個選擇嗰陣先會出樣式揀選器。大細係上一層嗰行嘅比例。",
  "settings.romanize.style": "羅馬拼音樣式",
  "settings.romanize.auto": "自動（該語言嘅預設）",
  "settings.romanize.none":
    "呢種語言冇讀音行（拉丁字母或者未支援）。",
  "settings.chooseTrack": "（請先喺上面揀一條字幕軌）",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "日文長音",
  "settings.longVowel.macrons": "長音符號（tōkyō）",
  "settings.longVowel.doubled": "重複元音（tookyoo）",
  "settings.longVowel.unmarked": "唔標（tokyo）",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "資料",
  "settings.data.contribute": "貢獻字幕資料",
  "settings.data.hint":
    "將你睇嘅片嘅字幕（影片標題/ID 同字幕文字 —— 永遠都唔會有關於你嘅嘢）發畀 Loom 嘅訓練語料庫，等我哋改善注音、羅馬拼音同將來嘅 OCR 支援。",
  "settings.turnOff": "喺呢個分頁熄咗 Loom",
  "settings.turnOff.hint":
    "熄咗之後會有粒細掣彈返出嚟，撳返佢就重新啟動到。呢個設定喺呢個分頁重新載入之後都仲喺度。",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "呢套嘢嘅字幕係圖片唔係文字，所以 Loom 讀唔到。試下揀套有文字字幕嘅嘢啦。",
  "settings.empty.noTracks": "呢條片冇支援到嘅字幕軌。",
  "settings.empty.discovering": "搵緊字幕…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "譯做",
  "settings.noTranslation": "（唔譯）",
  "settings.track.auto": "（自動）",
  "settings.badge.auto": "自動",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "手動",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "顏色",
  "settings.font": "字型",
  "settings.sizePx": "大細（px）",
  "settings.sizeRatio": "大細（上面行嘅比例）",
  "settings.opacity": "不透明度",
  "settings.advanced": "進階",
  "settings.outlineColor": "描邊顏色",
  "settings.outlineAlpha": "描邊透明度",
  "settings.glowRadius": "發光半徑（px）",
  "settings.glowNone": "0 = 冇發光",
  "settings.glowHalo": "{n}px 光暈",
  "settings.glowColor": "發光顏色",
  "settings.glowAlpha": "發光透明度",
  "settings.colorWheel": "開色輪",
  "settings.setColor": "將顏色設做 {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "自動（Noto + 系統後備字型）",
  "settings.font.systemSans": "系統無襯線字型",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "冇羅馬拼音",
  "settings.proc.latinNone": "拉丁字母（冇羅馬拼音）",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "異體字",
  "settings.variant.highlightColors": "標示同顏色",
  "settings.variant.colorCode": "同唔同嘅字標色",
  "settings.variant.simpSameAsTop": "簡體字：同上面行一樣",
  "settings.variant.simpColor": "簡體字顏色",
  "settings.variant.matchesTop": "同上面行一樣",
  "settings.variant.distinctColor": "一對一字顏色",
  "settings.variant.mergedColor": "合併字顏色",
  "settings.variant.preview": "預覽",
  "settings.variant.distinct": "一對一",
  "settings.variant.merged": "合併",
  // The bold "Distinct:" / "Merged:" labels reuse settings.variant.distinct /
  // .merged; these are the sentences that follow each label (no leading label).
  "settings.variant.distinctHint":
    "呢個繁體字有自己獨有嘅簡體寫法（語 → 语）。睇簡體嘅人分得出原本係邊個繁體字。",
  "settings.variant.mergedHint":
    "幾個繁體字共用同一個簡體寫法（髮 同 發 都 → 发）。原本嗰個字冇咗 —— 簡化就係喺呢度掉咗啲資訊。",
  // Rendered after a "{languageCode}: " prefix, so lowercase and prefix-less.
  "settings.variant.none":
    "呢個版本冇異體字功能。而家淨係支援繁體中文（zh-Hant / zh-TW / zh-HK / zh-MO / yue）。",
};
