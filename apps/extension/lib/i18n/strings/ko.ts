import type { LocaleTable } from "./en";

// Korean (한국어) UI strings. Keys and {param} placeholders match en.ts.
export const ko: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "외국어 영상을 위한 이중 자막.",
  "popup.enableLabel": "이 브라우저에서 Loom 사용",
  "popup.turnOff": "Loom 끄기",
  "popup.turnOn": "Loom 켜기",
  "popup.statusOn": "켜짐 — 호환되는 영상에서 Loom이 자동으로 표시됩니다.",
  "popup.statusOff": "꺼짐 — 다시 켤 때까지 Loom이 어디에서도 실행되지 않습니다.",
  "popup.checkApi": "API 확인",
  "popup.checking": "확인 중…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "오류: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "이미 보고 있는 콘텐츠로 언어를 배우세요.",
  "onboarding.step1.title": "영상 열기",
  "onboarding.step1.body":
    "Loom은 {platforms}에서 작동합니다 — 배우고 있는 언어의 자막이 있는 모든 영상에서요.",
  "onboarding.step2.title": "Loom pill 클릭",
  "onboarding.step2.body":
    "플레이어에 작은 {pill} pill이 나타납니다. 클릭하면 활성화됩니다 — 각 탭은 직접 켜기 전까지 꺼진 상태로 유지됩니다.",
  "onboarding.step3.title": "네 개의 레이어 모두 읽기",
  "onboarding.step3.body":
    "사용자 언어, 영상 언어, 발음 표기 줄, 그리고 글자별 읽기(후리가나, Pinyin 등). pill의 ⚙ 패널에서 모든 것을 맞춤 설정할 수 있습니다.",
  "onboarding.help.title": "Loom 개선을 도와주시겠어요?",
  "onboarding.help.body":
    "익명 자막 데이터를 기여하세요: 여러분이 보는 영상의 영상 ID와 자막 텍스트가 Loom의 학습 코퍼스에 공유되어 주석, 로마자 표기, 향후 OCR 지원을 개선합니다. 이 데이터는 여러분과 연결되지 않으며 — 계정도, IP 주소도, 식별자도 없습니다 — 동일한 콘텐츠는 아무리 많은 사람이 보더라도 한 번만 저장됩니다.",
  "onboarding.help.contribute": "자막 데이터 기여하기",
  "onboarding.help.decline": "괜찮습니다",
  "onboarding.help.thanks": "감사합니다! 자막 데이터를 기여하고 계십니다.",
  "onboarding.help.noProblem": "괜찮습니다 — 아무것도 공유되지 않습니다.",
  "onboarding.help.changeLater":
    "Loom pill의 ⚙ 설정 패널에서 언제든지 변경할 수 있습니다.",
  "onboarding.privacyPolicy": "개인정보 처리방침",
  "onboarding.helpFaq": "도움말 및 FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom 설정",
  "pill.discovering": "탐색 중…",
  "pill.noCaptions": "자막 없음",
  "pill.noSupportedTracks": "지원되는 트랙 없음",
  "pill.error": "오류 (콘솔 참조)",
  "dormant.activate": "이 탭에서 Loom 활성화",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Loom 개선을 도와주시겠어요?",
  "consent.body":
    "익명 자막 데이터(영상 ID + 자막 텍스트 — 여러분에 관한 정보는 절대 아님)를 기여하여 주석과 로마자 표기를 개선하세요.",
  "consent.contribute": "기여하기",
  "consent.decline": "괜찮습니다",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "{word}의 정의",
  "define.looking": "찾는 중…",
  "define.unreachable": "사전에 연결할 수 없습니다.",
  "define.noEntry": "사전 항목이 없습니다.",
  "define.breakdown": "분석",
  "define.glossLanguage": "사전 언어",
  "define.glossAuto": "자동",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (기본값)",
  "preset.loominate.desc": "Loom의 기본 파스텔 색상.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Loom 후원하기",
  "settings.title": "Loom 설정",
  "settings.close": "설정 닫기",
  "settings.feedback": "피드백 보내기",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "사용자 언어 (자동 선택 기준)",
  "settings.userLang.hint":
    "자동 선택은 모든 지역 변형과 일치합니다 (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "영상 언어 (Top) — 트랙 {count}개",
  "settings.bottomLang.title": "사용자 언어 (Bottom)",
  "settings.bottomLang.autoTranslate":
    "(자동: 일치하는 트랙이 없으면 {lang}(으)로 번역)",
  "settings.bottomLang.noAutoTranslate":
    "(없음 — {platform}에서는 자동 번역 없음)",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "위치",
  "settings.videoLang": "영상 언어",
  "settings.userLang": "사용자 언어",
  "settings.position.hint":
    "슬롯 1 = 해당 구역의 위쪽 줄, 슬롯 2 = 아래쪽 줄. 한 구역에 단독으로 있으면 구역의 기본 위치를 사용합니다.",
  "settings.position.topNudge": "Top 줄 — 세로 미세 조정",
  "settings.position.bottomNudge": "Bottom 줄 — 세로 미세 조정",
  "settings.position.lineSpacing": "줄 간격",
  "settings.position.nudgeHint":
    "미세 조정은 값을 올릴수록 줄을 화면 중앙 쪽으로 이동시킵니다(Top 줄은 아래로, Bottom 줄은 위로) — 레터박스 영상의 검은 여백에서 텍스트를 빼낼 때 유용합니다. 표지판과 세로 자막은 자체 위치를 유지합니다. 플랫폼별로 저장됩니다.",
  "settings.pos.top1": "↑ Top 1",
  "settings.pos.top2": "↑ Top 2",
  "settings.pos.bot1": "↓ Bot 1",
  "settings.pos.bot2": "↓ Bot 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "자막 크기",
  "settings.size.overall": "전체 크기",
  "settings.size.hint":
    "아래의 줄별 크기 위에 모든 줄을 함께 배율 조정합니다. 100%는 최적화된 기본값과 같습니다. 여기서 자막이 크게 표시되면(예: 전체 화면의 Netflix) 값을 낮추세요. 각 플랫폼마다 별도로 기억됩니다.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "색상 프리셋",
  "settings.preset.label": "프리셋",
  "settings.preset.custom": "(사용자 지정)",
  "settings.preset.noPreset": "(프리셋 없음 — 사용자 지정 색상)",
  "settings.preset.loading": "프리셋 불러오는 중…",
  "settings.preset.none":
    "사용 가능한 프리셋 없음 — 중국어, 일본어, 한국어, 태국어 또는 러시아어 트랙으로 전환하면 언어 테마 프리셋이 표시됩니다. 또는 아무 트랙에서나 Classic을 사용하세요.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Bottom — 사용자 언어",
  "settings.layer.showBottom": "Bottom 줄 표시",
  "settings.layer.top": "Top — 영상 언어",
  "settings.layer.showTop": "Top 줄 표시",
  "settings.layer.linkOpacity":
    "불투명도 연동 (주석, 로마자 표기, 대체 표기)",
  "settings.layer.linkOpacityAria": "Top 그룹 불투명도 연동",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "글자별 주석",
  "settings.annotation.userLangAdvanced": "사용자 언어 주석",
  "settings.annotation.hint":
    "각 글자 위의 작은 읽기 — 일본어는 후리가나, 중국어는 Pinyin / Zhuyin / Jyutping, 한국어는 로마자 표기. 중국어, 일본어, 한국어에서 사용할 수 있습니다. 크기는 Top 줄의 비율입니다 (0.5 = 절반).",
  "settings.annotate.none": "이 언어에는 아직 글자별 주석이 없습니다.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "로마자 표기 (발음 줄)",
  "settings.romanization.userLangAdvanced": "사용자 언어 로마자 표기",
  "settings.romanization.hint":
    "영상 텍스트 위의 전체 발음 줄. 중국어, 일본어, 한국어, 키릴 문자, 태국어, 인도계 문자, 히브리어, 아랍어 / 페르시아어 / 우르두어 문자에서 사용할 수 있습니다. 스타일 선택기는 옵션이 두 개 이상일 때만 표시됩니다. 크기는 상위 줄의 비율입니다.",
  "settings.romanize.style": "로마자 표기 스타일",
  "settings.romanize.auto": "자동 (언어 기본값)",
  "settings.romanize.none":
    "이 언어에는 발음 줄이 없습니다 (라틴 문자이거나 지원되지 않음).",
  "settings.chooseTrack": "(먼저 위에서 트랙을 선택하세요)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "일본어 장음",
  "settings.longVowel.macrons": "장음 부호 (tōkyō)",
  "settings.longVowel.doubled": "모음 중복 (tookyoo)",
  "settings.longVowel.unmarked": "표시 없음 (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "데이터",
  "settings.data.contribute": "자막 데이터 기여하기",
  "settings.data.hint":
    "여러분이 보는 영상의 자막(영상 제목/ID와 자막 텍스트 — 여러분에 관한 정보는 절대 아님)을 Loom의 학습 코퍼스에 보내 주석, 로마자 표기, 향후 OCR 지원을 개선합니다.",
  "settings.turnOff": "이 탭에서 Loom 끄기",
  "settings.turnOff.hint":
    "끄면 다시 나타나는 작은 pill을 통해 재활성화할 수 있습니다. 이 탭을 다시 불러와도 유지됩니다.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "이 작품의 자막은 텍스트가 아닌 이미지여서 Loom이 읽을 수 없습니다. 텍스트 기반 자막이 있는 작품을 시도해 보세요.",
  "settings.empty.noTracks": "이 영상에는 지원되는 자막 트랙이 없습니다.",
  "settings.empty.discovering": "자막 탐색 중…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "번역 대상",
  "settings.noTranslation": "(번역 없음)",
  "settings.track.auto": "(자동)",
  "settings.badge.auto": "자동",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "수동",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "색상",
  "settings.font": "글꼴",
  "settings.sizePx": "크기 (px)",
  "settings.sizeRatio": "크기 (Top 대비 비율)",
  "settings.opacity": "불투명도",
  "settings.advanced": "고급",
  "settings.outlineColor": "외곽선 색상",
  "settings.outlineAlpha": "외곽선 알파",
  "settings.glowRadius": "글로우 반경 (px)",
  "settings.glowNone": "0 = 글로우 없음",
  "settings.glowHalo": "{n}px 후광",
  "settings.glowColor": "글로우 색상",
  "settings.glowAlpha": "글로우 알파",
  "settings.colorWheel": "색상 휠 열기",
  "settings.setColor": "색상을 {hex}(으)로 설정",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "자동 (Noto + 시스템 대체)",
  "settings.font.systemSans": "시스템 산세리프",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "로마자 표기 없음",
  "settings.proc.latinNone": "라틴 문자 (로마자 표기 없음)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "대체 표기",
  "settings.variant.highlightColors": "강조 및 색상",
  "settings.variant.colorCode": "다른 글자 색상 구분",
  "settings.variant.simpSameAsTop": "간체자: Top과 동일",
  "settings.variant.simpColor": "간체자 색상",
  "settings.variant.matchesTop": "Top과 일치",
  "settings.variant.distinctColor": "Distinct 글자 색상",
  "settings.variant.mergedColor": "Merged 글자 색상",
  "settings.variant.preview": "미리보기",
  "settings.variant.distinct": "Distinct",
  "settings.variant.merged": "Merged",
  "settings.variant.distinctHint":
    "그 번체자는 고유한 간체자 형태를 가집니다 (語 → 语). 간체자를 읽는 사람이 어떤 번체자를 의도했는지 알 수 있습니다.",
  "settings.variant.mergedHint":
    "여러 번체자가 같은 간체자 형태를 공유합니다 (髮과 發 모두 → 发). 원래 글자는 사라집니다 — 간체화가 정보를 버리는 지점이 바로 여기입니다.",
  "settings.variant.none":
    "이 빌드에는 표기 변형이 없습니다. 현재는 번체 중국어(zh-Hant / zh-TW / zh-HK / zh-MO / yue)만 지원됩니다.",
} as const satisfies Record<string, string>;
