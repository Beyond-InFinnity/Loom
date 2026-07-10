import type { LocaleTable } from "./en";

// Simplified Chinese (简体中文) UI strings. Keys and {param} placeholders match en.ts.
export const zh: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "为外语视频提供双语字幕。",
  "popup.enableLabel": "在此浏览器启用 Loom",
  "popup.turnOff": "关闭 Loom",
  "popup.turnOn": "开启 Loom",
  "popup.statusOn": "已开启 —— Loom 会在受支持的视频上自动出现。",
  "popup.statusOff": "已关闭 —— 重新开启前 Loom 不会在任何地方运行。",
  "popup.checkApi": "检查 API",
  "popup.checking": "检查中…",
  "popup.apiHost": "API：{host}",
  "popup.httpStatus": "HTTP {status}：{body}",
  "popup.error": "错误：{message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "从你已经在看的剧集中学习语言。",
  "onboarding.step1.title": "打开一个视频",
  "onboarding.step1.body":
    "Loom 支持 {platforms} —— 任何带有你正在学习语言字幕的视频。",
  "onboarding.step2.title": "点击 Loom 药丸按钮",
  "onboarding.step2.body":
    "播放器中会出现一个小小的 {pill} 药丸按钮。点击它即可激活 —— 在你主动开启前，每个标签页都保持关闭。",
  "onboarding.step3.title": "阅读全部四层内容",
  "onboarding.step3.body":
    "你的语言、视频的语言、一行注音，以及逐字读音（furigana、Pinyin 等）。药丸按钮上的 ⚙ 面板可自定义一切。",
  "onboarding.help.title": "帮助改进 Loom？",
  "onboarding.help.body":
    "贡献匿名字幕数据：你观看的视频会将其视频 ID 和字幕文本共享给 Loom 的训练语料库，以改进注音、罗马音转写以及未来的 OCR 支持。这些数据绝不会与你关联 —— 没有账号、没有 IP 地址、没有任何标识符 —— 无论多少人观看，相同内容都只存储一次。",
  "onboarding.help.contribute": "贡献字幕数据",
  "onboarding.help.decline": "不用了",
  "onboarding.help.thanks": "谢谢！你正在贡献字幕数据。",
  "onboarding.help.noProblem": "没问题 —— 不会共享任何内容。",
  "onboarding.help.changeLater":
    "你随时可以在 Loom 药丸按钮的 ⚙ 设置面板中更改此项。",
  "onboarding.privacyPolicy": "隐私政策",
  "onboarding.helpFaq": "帮助与常见问题",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom 设置",
  "pill.discovering": "查找中…",
  "pill.noCaptions": "无字幕",
  "pill.noSupportedTracks": "无受支持的字幕轨",
  "pill.error": "错误（详见控制台）",
  "dormant.activate": "在此标签页激活 Loom",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "帮助改进 Loom？",
  "consent.body":
    "贡献匿名字幕数据（视频 ID + 字幕文本 —— 绝不包含任何关于你的信息），以改进注音和罗马音转写。",
  "consent.contribute": "贡献",
  "consent.decline": "不用了",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "{word} 的释义",
  "define.looking": "查询中…",
  "define.unreachable": "无法连接词典。",
  "define.noEntry": "无词典释义。",
  "define.breakdown": "拆解",
  "define.glossLanguage": "词典语言",
  "define.glossAuto": "自动",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate（默认）",
  "preset.loominate.desc": "Loom 的默认柔和配色。",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "支持 Loom",
  "settings.title": "Loom 设置",
  "settings.close": "关闭设置",
  "settings.feedback": "发送反馈",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "用户语言（自动选择的基准）",
  "settings.userLang.hint":
    "自动选择会匹配任何地区变体（en → en-US、en-GB、en-AU…）。",
  "settings.videoLang.title": "视频语言（上方）—— {count} 条字幕轨",
  "settings.bottomLang.title": "用户语言（下方）",
  "settings.bottomLang.autoTranslate":
    "（自动：无匹配字幕轨时翻译为 {lang}）",
  "settings.bottomLang.noAutoTranslate":
    "（无 —— {platform} 上不提供自动翻译）",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "位置",
  "settings.videoLang": "视频语言",
  "settings.userLang": "用户语言",
  "settings.position.hint":
    "槽位 1 = 所在区域的上方一行，槽位 2 = 下方一行。区域内仅有一行时，使用该区域的默认位置。",
  "settings.position.topNudge": "上方一行 —— 垂直微调",
  "settings.position.bottomNudge": "下方一行 —— 垂直微调",
  "settings.position.lineSpacing": "行间距",
  "settings.position.nudgeHint":
    "微调会在你调高数值时将该行移向画面中央（上方行下移，下方行上移）—— 便于把文字拉离带黑边视频的黑边区域。标牌和竖排字幕会保持各自的位置。按平台分别保存。",
  "settings.pos.top1": "↑ 上 1",
  "settings.pos.top2": "↑ 上 2",
  "settings.pos.bot1": "↓ 下 1",
  "settings.pos.bot2": "↓ 下 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "字幕大小",
  "settings.size.overall": "整体大小",
  "settings.size.hint":
    "在下方各行单独大小的基础上，同时缩放所有行。100% 对应调校后的默认值；如果字幕在此处显得过大（例如全屏播放的 Netflix），可将其调低。按平台分别记忆。",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "配色预设",
  "settings.preset.label": "预设",
  "settings.preset.custom": "（自定义）",
  "settings.preset.noPreset": "（无预设 —— 自定义配色）",
  "settings.preset.loading": "正在加载预设…",
  "settings.preset.none":
    "暂无可用预设 —— 切换到中文、日文、韩文、泰文或俄文字幕轨即可看到相应语言主题的预设，或在任何字幕轨上使用 Classic。",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "下方 —— 用户语言",
  "settings.layer.showBottom": "显示下方一行",
  "settings.layer.top": "上方 —— 视频语言",
  "settings.layer.showTop": "显示上方一行",
  "settings.layer.linkOpacity":
    "联动不透明度（注音、罗马音转写、异体字）",
  "settings.layer.linkOpacityAria": "联动上方组的不透明度",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "逐字注音",
  "settings.annotation.userLangAdvanced": "用户语言注音",
  "settings.annotation.hint":
    "每个字符上方的小号读音 —— 日文的 furigana，中文的 Pinyin / Zhuyin / Jyutping，韩文的罗马音转写。支持中文、日文和韩文。大小为上方一行的比例（0.5 = 一半）。",
  "settings.annotate.none": "此语言暂无逐字注音。",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "罗马音转写（注音行）",
  "settings.romanization.userLangAdvanced": "用户语言罗马音转写",
  "settings.romanization.hint":
    "视频文字上方的完整读音行。支持中文、日文、韩文、西里尔文、泰文、印度诸文字、希伯来文以及阿拉伯文 / 波斯文 / 乌尔都文。仅当有多个选项时才会出现样式选择器。大小为所在行的比例。",
  "settings.romanize.style": "罗马音转写样式",
  "settings.romanize.auto": "自动（该语言的默认值）",
  "settings.romanize.none":
    "此语言无读音行（拉丁字母或不支持）。",
  "settings.chooseTrack": "（请先在上方选择一条字幕轨）",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "日语长音",
  "settings.longVowel.macrons": "长音符号（tōkyō）",
  "settings.longVowel.doubled": "重复元音（tookyoo）",
  "settings.longVowel.unmarked": "不标注（tokyo）",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "数据",
  "settings.data.contribute": "贡献字幕数据",
  "settings.data.hint":
    "将你观看视频的字幕（视频标题/ID 和字幕文本 —— 绝不包含任何关于你的信息）发送给 Loom 的训练语料库，以改进注音、罗马音转写以及未来的 OCR 支持。",
  "settings.turnOff": "在此标签页关闭 Loom",
  "settings.turnOff.hint":
    "关闭后会出现一个小药丸按钮，可通过它重新激活。此设置在本标签页重新加载后仍然保留。",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "此片名的字幕是图片而非文本，因此 Loom 无法读取。请尝试带有文本字幕的片名。",
  "settings.empty.noTracks": "此视频没有受支持的字幕轨。",
  "settings.empty.discovering": "正在查找字幕…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "翻译为",
  "settings.noTranslation": "（不翻译）",
  "settings.track.auto": "（自动）",
  "settings.badge.auto": "自动",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "手动",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "颜色",
  "settings.font": "字体",
  "settings.sizePx": "大小（px）",
  "settings.sizeRatio": "大小（相对上方行的比例）",
  "settings.opacity": "不透明度",
  "settings.advanced": "高级",
  "settings.outlineColor": "描边颜色",
  "settings.outlineAlpha": "描边透明度",
  "settings.glowRadius": "发光半径（px）",
  "settings.glowNone": "0 = 无发光",
  "settings.glowHalo": "{n}px 光晕",
  "settings.glowColor": "发光颜色",
  "settings.glowAlpha": "发光透明度",
  "settings.colorWheel": "打开色轮",
  "settings.setColor": "将颜色设为 {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "自动（Noto + 系统后备字体）",
  "settings.font.systemSans": "系统无衬线字体",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "无罗马音转写",
  "settings.proc.latinNone": "拉丁字母（无罗马音转写）",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "异体字",
  "settings.variant.highlightColors": "高亮与配色",
  "settings.variant.colorCode": "为不同字符标注颜色",
  "settings.variant.simpSameAsTop": "简体字：同上方一行",
  "settings.variant.simpColor": "简体字颜色",
  "settings.variant.matchesTop": "同上方一行",
  "settings.variant.distinctColor": "一对一字符颜色",
  "settings.variant.mergedColor": "合并字符颜色",
  "settings.variant.preview": "预览",
  "settings.variant.distinct": "一对一",
  "settings.variant.merged": "合并",
  "settings.variant.distinctHint":
    "这个繁体字有自己独有的简体形式（語 → 语）。读简体的人能判断原本是哪个繁体字。",
  "settings.variant.mergedHint":
    "多个繁体字共用同一个简体形式（髮 和 發 都 → 发）。原字信息丢失 —— 这正是简化过程中丢弃信息的地方。",
  "settings.variant.none":
    "此版本不含异体字功能。目前仅支持繁体中文（zh-Hant / zh-TW / zh-HK / zh-MO / yue）。",
};
