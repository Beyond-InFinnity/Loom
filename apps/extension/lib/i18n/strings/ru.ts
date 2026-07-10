import type { LocaleTable } from "./en";

// Russian (Русский) UI strings. Keys and {param} placeholders match en.ts.
export const ru: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Двойные субтитры для видео на иностранном языке.",
  "popup.enableLabel": "Loom в этом браузере",
  "popup.turnOff": "Выключить Loom",
  "popup.turnOn": "Включить Loom",
  "popup.statusOn": "ВКЛ — Loom появляется автоматически на подходящих видео.",
  "popup.statusOff": "ВЫКЛ — Loom нигде не работает, пока ты снова его не включишь.",
  "popup.checkApi": "Проверить API",
  "popup.checking": "Проверяем…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Ошибка: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Учи языки по сериалам, которые ты и так смотришь.",
  "onboarding.step1.title": "Открой видео",
  "onboarding.step1.body":
    "Loom работает на {platforms} — на любом видео с субтитрами на языке, который ты учишь.",
  "onboarding.step2.title": "Нажми на кнопку Loom",
  "onboarding.step2.body":
    "В плеере появляется маленькая кнопка {pill}. Нажми на неё, чтобы активировать — каждая вкладка остаётся выключенной, пока ты сам не попросишь.",
  "onboarding.step3.title": "Читай все четыре слоя",
  "onboarding.step3.body":
    "Твой язык, язык видео, фонетическая строка и чтения над каждым символом (furigana, Pinyin и другие). Панель ⚙ на кнопке настраивает всё.",
  "onboarding.help.title": "Помочь сделать Loom лучше?",
  "onboarding.help.body":
    "Поделись анонимными данными субтитров: видео, которые ты смотришь, передают свой ID видео и текст субтитров в обучающий корпус Loom, чтобы улучшить аннотации, романизацию и будущую поддержку OCR. Это никогда не связывается с тобой — ни аккаунта, ни IP-адреса, ни идентификаторов — а одинаковый контент хранится лишь один раз, сколько бы людей его ни смотрели.",
  "onboarding.help.contribute": "Поделиться данными субтитров",
  "onboarding.help.decline": "Нет, спасибо",
  "onboarding.help.thanks": "Спасибо! Ты делишься данными субтитров.",
  "onboarding.help.noProblem": "Без проблем — ничего не будет передано.",
  "onboarding.help.changeLater":
    "Ты можешь изменить это в любой момент в панели настроек ⚙ кнопки Loom.",
  "onboarding.privacyPolicy": "Политика конфиденциальности",
  "onboarding.helpFaq": "Помощь и FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Настройки Loom",
  "pill.discovering": "поиск…",
  "pill.noCaptions": "нет субтитров",
  "pill.noSupportedTracks": "нет поддерживаемых дорожек",
  "pill.error": "ошибка (смотри консоль)",
  "dormant.activate": "Активировать Loom на этой вкладке",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Помочь сделать Loom лучше?",
  "consent.body":
    "Поделись анонимными данными субтитров (ID видео + текст субтитров — никогда ничего о тебе), чтобы улучшить аннотации и романизацию.",
  "consent.contribute": "Поделиться",
  "consent.decline": "Нет, спасибо",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Определение слова {word}",
  "define.looking": "Ищем…",
  "define.unreachable": "Не удалось связаться со словарём.",
  "define.noEntry": "Нет статьи в словаре.",
  "define.breakdown": "Разбор",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (по умолчанию)",
  "preset.loominate.desc": "Пастельные цвета Loom по умолчанию.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Поддержать Loom",
  "settings.title": "Настройки Loom",
  "settings.close": "Закрыть настройки",
  "settings.feedback": "Отправить отзыв",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Язык пользователя (основа автовыбора)",
  "settings.userLang.hint":
    "Автовыбор подходит к любому региональному варианту (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Язык видео (верхняя строка) — дорожек: {count}",
  "settings.bottomLang.title": "Язык пользователя (нижняя строка)",
  "settings.bottomLang.autoTranslate":
    "(авто: переводить на {lang}, когда нет подходящей дорожки)",
  "settings.bottomLang.noAutoTranslate":
    "(нет — нет автоперевода на {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Положение",
  "settings.videoLang": "Язык видео",
  "settings.userLang": "Язык пользователя",
  "settings.position.hint":
    "Слот 1 = верхняя строка в своей зоне, слот 2 = нижняя. Единственная строка в зоне занимает положение по умолчанию для этой зоны.",
  "settings.position.topNudge": "Верхняя строка — вертикальный сдвиг",
  "settings.position.bottomNudge": "Нижняя строка — вертикальный сдвиг",
  "settings.position.lineSpacing": "Межстрочный интервал",
  "settings.position.nudgeHint":
    "Сдвиг двигает строку к центру кадра по мере её подъёма (вниз для верхней строки, вверх для нижней) — удобно, чтобы убрать текст с чёрных полос на видео с леттербоксом. Надписи и вертикальные субтитры сохраняют своё положение. Сохраняется отдельно для каждой платформы.",
  "settings.pos.top1": "↑ Верх 1",
  "settings.pos.top2": "↑ Верх 2",
  "settings.pos.bot1": "↓ Низ 1",
  "settings.pos.bot2": "↓ Низ 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Размер субтитров",
  "settings.size.overall": "Общий размер",
  "settings.size.hint":
    "Масштабирует все строки вместе, поверх размеров каждой строки ниже. 100% соответствует настроенному значению по умолчанию; уменьши, если субтитры отображаются здесь крупно (например, Netflix в полноэкранном режиме). Запоминается отдельно для каждой платформы.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Цветовые пресеты",
  "settings.preset.label": "Пресет",
  "settings.preset.custom": "(свой)",
  "settings.preset.noPreset": "(без пресета — свои цвета)",
  "settings.preset.loading": "Загружаем пресеты…",
  "settings.preset.none":
    "Пресеты недоступны — переключись на китайскую, японскую, корейскую, тайскую или русскую дорожку, чтобы увидеть пресеты по языку, или используй Classic на любой дорожке.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Нижняя — язык пользователя",
  "settings.layer.showBottom": "Показывать нижнюю строку",
  "settings.layer.top": "Верхняя — язык видео",
  "settings.layer.showTop": "Показывать верхнюю строку",
  "settings.layer.linkOpacity":
    "Связать непрозрачность (аннотация, романизация, альт. написание)",
  "settings.layer.linkOpacityAria": "Связать непрозрачность группы верхней строки",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Аннотация над символами",
  "settings.annotation.userLangAdvanced": "Аннотация языка пользователя",
  "settings.annotation.hint":
    "Мелкие чтения над каждым символом — furigana для японского, Pinyin / Zhuyin / Jyutping для китайского, романизация для корейского. Доступно для китайского, японского и корейского. Размер — доля от верхней строки (0,5 = половина).",
  "settings.annotate.none": "Для этого языка пока нет аннотации над символами.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Романизация (фонетическая строка)",
  "settings.romanization.userLangAdvanced": "Романизация языка пользователя",
  "settings.romanization.hint":
    "Полная строка произношения над текстом видео. Доступна для китайского, японского, корейского, кириллицы, тайского, индийских письменностей, иврита и арабского / персидского / урду. Выбор стиля появляется только там, где есть больше одного варианта. Размер — доля от родительской строки.",
  "settings.romanize.style": "Стиль романизации",
  "settings.romanize.auto": "Авто (по умолчанию для языка)",
  "settings.romanize.none":
    "Для этого языка нет строки произношения (латиница или не поддерживается).",
  "settings.chooseTrack": "(сначала выбери дорожку выше)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Долгие гласные в японском",
  "settings.longVowel.macrons": "Макроны (tōkyō)",
  "settings.longVowel.doubled": "Удвоенные гласные (tookyoo)",
  "settings.longVowel.unmarked": "Без обозначения (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Данные",
  "settings.data.contribute": "Поделиться данными субтитров",
  "settings.data.hint":
    "Отправляет субтитры видео, которые ты смотришь (название/ID видео и текст субтитров — никогда ничего о тебе), в обучающий корпус Loom, чтобы улучшить аннотации, романизацию и будущую поддержку OCR.",
  "settings.turnOff": "Выключить Loom на этой вкладке",
  "settings.turnOff.hint":
    "Активируй снова через маленькую кнопку, которая появляется, когда ты его выключаешь. Сохраняется при перезагрузках этой вкладки.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Субтитры этого видео — изображения, а не текст, поэтому Loom не может их прочитать. Попробуй видео с текстовыми субтитрами.",
  "settings.empty.noTracks": "На этом видео нет поддерживаемых дорожек субтитров.",
  "settings.empty.discovering": "Ищем субтитры…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Перевести на",
  "settings.noTranslation": "(без перевода)",
  "settings.track.auto": "(авто)",
  "settings.badge.auto": "авто",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "ручные",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Цвет",
  "settings.font": "Шрифт",
  "settings.sizePx": "Размер (px)",
  "settings.sizeRatio": "Размер (доля от верхней)",
  "settings.opacity": "Непрозрачность",
  "settings.advanced": "Дополнительно",
  "settings.outlineColor": "Цвет обводки",
  "settings.outlineAlpha": "Прозрачность обводки",
  "settings.glowRadius": "Радиус свечения (px)",
  "settings.glowNone": "0 = без свечения",
  "settings.glowHalo": "ореол {n}px",
  "settings.glowColor": "Цвет свечения",
  "settings.glowAlpha": "Прозрачность свечения",
  "settings.colorWheel": "Открыть цветовой круг",
  "settings.setColor": "Установить цвет {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Авто (Noto + системный запасной)",
  "settings.font.systemSans": "Системный без засечек",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "без романизации",
  "settings.proc.latinNone": "латиница (без романизации)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Альтернативное написание",
  "settings.variant.highlightColors": "Подсветка и цвета",
  "settings.variant.colorCode": "Выделять цветом отличающиеся символы",
  "settings.variant.simpSameAsTop": "Упрощённый символ: как верхняя строка",
  "settings.variant.simpColor": "Цвет упрощённого символа",
  "settings.variant.matchesTop": "как у верхней",
  "settings.variant.distinctColor": "Цвет однозначного символа",
  "settings.variant.mergedColor": "Цвет слитого символа",
  "settings.variant.preview": "Предпросмотр",
  "settings.variant.distinct": "Однозначный",
  "settings.variant.merged": "Слитый",
  "settings.variant.distinctHint":
    "у традиционного символа есть собственная уникальная упрощённая форма (語 → 语). По упрощённому можно понять, какой традиционный имелся в виду.",
  "settings.variant.mergedHint":
    "несколько традиционных символов имеют одинаковую упрощённую форму (髮 и 發 оба → 发). Оригинал теряется — вот где упрощение отбрасывает информацию.",
  "settings.variant.none":
    "В этой сборке нет варианта написания. Сегодня поддерживается только традиционный китайский (zh-Hant / zh-TW / zh-HK / zh-MO / yue).",
};
