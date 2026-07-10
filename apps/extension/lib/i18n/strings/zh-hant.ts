import type { LocaleTable } from "./en";

// Traditional Chinese (繁體中文, Taiwan) UI strings. Keys and {param} placeholders match en.ts.
export const zhHant: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "為外語影片提供雙語字幕。",
  "popup.enableLabel": "在此瀏覽器啟用 Loom",
  "popup.turnOff": "關閉 Loom",
  "popup.turnOn": "開啟 Loom",
  "popup.statusOn": "已開啟 —— Loom 會在支援的影片上自動出現。",
  "popup.statusOff": "已關閉 —— 重新開啟前 Loom 不會在任何地方執行。",
  "popup.checkApi": "檢查 API",
  "popup.checking": "檢查中…",
  "popup.apiHost": "API：{host}",
  "popup.httpStatus": "HTTP {status}：{body}",
  "popup.error": "錯誤：{message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "從你已經在看的節目中學習語言。",
  "onboarding.step1.title": "開啟一部影片",
  "onboarding.step1.body":
    "Loom 支援 {platforms} —— 任何帶有你正在學習語言字幕的影片。",
  "onboarding.step2.title": "點選 Loom 藥丸按鈕",
  "onboarding.step2.body":
    "播放器中會出現一個小小的 {pill} 藥丸按鈕。點選它即可啟用 —— 在你主動開啟前，每個分頁都保持關閉。",
  "onboarding.step3.title": "閱讀全部四層內容",
  "onboarding.step3.body":
    "你的語言、影片的語言、一行注音，以及逐字讀音（furigana、Pinyin 等）。藥丸按鈕上的 ⚙ 面板可自訂一切。",
  "onboarding.help.title": "幫忙改進 Loom？",
  "onboarding.help.body":
    "貢獻匿名字幕資料：你觀看的影片會將其影片 ID 與字幕文字分享給 Loom 的訓練語料庫，以改進注解、羅馬拼音以及未來的 OCR 支援。這些資料絕不會與你連結 —— 沒有帳號、沒有 IP 位址、沒有任何識別資訊 —— 而且無論多少人觀看，相同內容都只儲存一次。",
  "onboarding.help.contribute": "貢獻字幕資料",
  "onboarding.help.decline": "不用了",
  "onboarding.help.thanks": "謝謝你！你正在貢獻字幕資料。",
  "onboarding.help.noProblem": "沒問題 —— 不會分享任何內容。",
  "onboarding.help.changeLater":
    "你隨時可以在 Loom 藥丸按鈕的 ⚙ 設定面板中變更此項。",
  "onboarding.privacyPolicy": "隱私權政策",
  "onboarding.helpFaq": "說明與常見問題",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom 設定",
  "pill.discovering": "尋找中…",
  "pill.noCaptions": "無字幕",
  "pill.noSupportedTracks": "無支援的字幕軌",
  "pill.error": "錯誤（詳見主控台）",
  "dormant.activate": "在此分頁啟用 Loom",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "幫忙改進 Loom？",
  "consent.body":
    "貢獻匿名字幕資料（影片 ID + 字幕文字 —— 絕不包含任何關於你的資訊），以改進注解與羅馬拼音。",
  "consent.contribute": "貢獻",
  "consent.decline": "不用了",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "{word} 的釋義",
  "define.looking": "查詢中…",
  "define.unreachable": "無法連線至字典。",
  "define.noEntry": "查無字典釋義。",
  "define.breakdown": "拆解",
  "define.glossLanguage": "詞典語言",
  "define.glossAuto": "自動",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate（預設）",
  "preset.loominate.desc": "Loom 的預設柔和配色。",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "支持 Loom",
  "settings.title": "Loom 設定",
  "settings.close": "關閉設定",
  "settings.feedback": "傳送意見回饋",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "使用者語言（自動選擇的基準）",
  "settings.userLang.hint":
    "自動選擇會比對任何地區變體（en → en-US、en-GB、en-AU…）。",
  "settings.videoLang.title": "影片語言（上方）—— {count} 條字幕軌",
  "settings.bottomLang.title": "使用者語言（下方）",
  "settings.bottomLang.autoTranslate":
    "（自動：無相符字幕軌時翻譯為 {lang}）",
  "settings.bottomLang.noAutoTranslate":
    "（無 —— {platform} 上不提供自動翻譯）",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "位置",
  "settings.videoLang": "影片語言",
  "settings.userLang": "使用者語言",
  "settings.position.hint":
    "槽位 1 = 所在區域的上方一行，槽位 2 = 下方一行。區域內僅有一行時，使用該區域的預設位置。",
  "settings.position.topNudge": "上方一行 —— 垂直微調",
  "settings.position.bottomNudge": "下方一行 —— 垂直微調",
  "settings.position.lineSpacing": "行距",
  "settings.position.nudgeHint":
    "微調會在你調高數值時將該行移向畫面中央（上方行下移，下方行上移）—— 便於把文字拉離黑邊影片的黑邊區域。標示和直排字幕會保持各自的位置。依平台分別儲存。",
  "settings.pos.top1": "↑ 上 1",
  "settings.pos.top2": "↑ 上 2",
  "settings.pos.bot1": "↓ 下 1",
  "settings.pos.bot2": "↓ 下 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "字幕大小",
  "settings.size.overall": "整體大小",
  "settings.size.hint":
    "在下方各行單獨大小的基礎上，同時縮放所有行。100% 對應調校後的預設值；若字幕在此顯得過大（例如全螢幕播放的 Netflix），可將其調低。依平台分別記憶。",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "配色預設",
  "settings.preset.label": "預設",
  "settings.preset.custom": "（自訂）",
  "settings.preset.noPreset": "（無預設 —— 自訂配色）",
  "settings.preset.loading": "正在載入預設…",
  "settings.preset.none":
    "目前無可用預設 —— 切換到中文、日文、韓文、泰文或俄文字幕軌即可看到相應語言主題的預設，或在任何字幕軌上使用 Classic。",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "下方 —— 使用者語言",
  "settings.layer.showBottom": "顯示下方一行",
  "settings.layer.top": "上方 —— 影片語言",
  "settings.layer.showTop": "顯示上方一行",
  "settings.layer.linkOpacity":
    "連動不透明度（注解、羅馬拼音、異體字）",
  "settings.layer.linkOpacityAria": "連動上方群組的不透明度",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "逐字注解",
  "settings.annotation.userLangAdvanced": "使用者語言注解",
  "settings.annotation.hint":
    "每個字上方的小號讀音 —— 日文的 furigana，中文的 Pinyin / Zhuyin / Jyutping，韓文的羅馬拼音。支援中文、日文與韓文。大小為上方一行的比例（0.5 = 一半）。",
  "settings.annotate.none": "此語言尚無逐字注解。",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "羅馬拼音（注音行）",
  "settings.romanization.userLangAdvanced": "使用者語言羅馬拼音",
  "settings.romanization.hint":
    "影片文字上方的完整讀音行。支援中文、日文、韓文、西里爾文、泰文、印度諸文字、希伯來文以及阿拉伯文 / 波斯文 / 烏爾都文。僅在有多個選項時才會出現樣式選擇器。大小為所在行的比例。",
  "settings.romanize.style": "羅馬拼音樣式",
  "settings.romanize.auto": "自動（該語言的預設值）",
  "settings.romanize.none":
    "此語言無讀音行（拉丁字母或不支援）。",
  "settings.chooseTrack": "（請先在上方選擇一條字幕軌）",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "日文長音",
  "settings.longVowel.macrons": "長音符號（tōkyō）",
  "settings.longVowel.doubled": "重複母音（tookyoo）",
  "settings.longVowel.unmarked": "不標示（tokyo）",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "資料",
  "settings.data.contribute": "貢獻字幕資料",
  "settings.data.hint":
    "將你觀看影片的字幕（影片標題/ID 與字幕文字 —— 絕不包含任何關於你的資訊）傳送給 Loom 的訓練語料庫，以改進注解、羅馬拼音以及未來的 OCR 支援。",
  "settings.turnOff": "在此分頁關閉 Loom",
  "settings.turnOff.hint":
    "關閉後會出現一個小藥丸按鈕，可透過它重新啟用。此設定在本分頁重新載入後仍會保留。",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "此片的字幕是圖片而非文字，因此 Loom 無法讀取。請改試帶有文字字幕的影片。",
  "settings.empty.noTracks": "此影片沒有支援的字幕軌。",
  "settings.empty.discovering": "正在尋找字幕…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "翻譯為",
  "settings.noTranslation": "（不翻譯）",
  "settings.track.auto": "（自動）",
  "settings.badge.auto": "自動",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "手動",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "顏色",
  "settings.font": "字型",
  "settings.sizePx": "大小（px）",
  "settings.sizeRatio": "大小（相對上方行的比例）",
  "settings.opacity": "不透明度",
  "settings.advanced": "進階",
  "settings.outlineColor": "外框顏色",
  "settings.outlineAlpha": "外框透明度",
  "settings.glowRadius": "光暈半徑（px）",
  "settings.glowNone": "0 = 無光暈",
  "settings.glowHalo": "{n}px 光暈",
  "settings.glowColor": "光暈顏色",
  "settings.glowAlpha": "光暈透明度",
  "settings.colorWheel": "開啟色輪",
  "settings.setColor": "將顏色設為 {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "自動（Noto + 系統後備字型）",
  "settings.font.systemSans": "系統無襯線字型",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "無羅馬拼音",
  "settings.proc.latinNone": "拉丁字母（無羅馬拼音）",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "異體字",
  "settings.variant.highlightColors": "醒目標示與配色",
  "settings.variant.colorCode": "以顏色標示相異的字",
  "settings.variant.simpSameAsTop": "簡體字：同上方一行",
  "settings.variant.simpColor": "簡體字顏色",
  "settings.variant.matchesTop": "同上方一行",
  "settings.variant.distinctColor": "一對一字顏色",
  "settings.variant.mergedColor": "合併字顏色",
  "settings.variant.preview": "預覽",
  "settings.variant.distinct": "一對一",
  "settings.variant.merged": "合併",
  // The bold "Distinct:" / "Merged:" labels reuse settings.variant.distinct /
  // .merged; these are the sentences that follow each label (no leading label).
  "settings.variant.distinctHint":
    "這個繁體字有專屬的簡體對應形式（語 → 语）。讀簡體的人能判斷原本指的是哪個繁體字。",
  "settings.variant.mergedHint":
    "多個繁體字共用同一個簡體形式（髮 和 發 都 → 发）。原字資訊就此消失 —— 這正是簡化過程捨棄資訊之處。",
  // Rendered after a "{languageCode}: " prefix, so lowercase and prefix-less.
  "settings.variant.none":
    "此版本尚無異體字功能。目前僅支援繁體中文（zh-Hant / zh-TW / zh-HK / zh-MO / yue）。",
};
