import type { LocaleTable } from "./en";

// Ukrainian (Українська) UI strings. Keys and {param} placeholders match en.ts.
export const uk: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Подвійні субтитри для відео іноземною мовою.",
  "popup.enableLabel": "Loom у цьому браузері",
  "popup.turnOff": "Вимкнути Loom",
  "popup.turnOn": "Увімкнути Loom",
  "popup.statusOn": "УВІМКНЕНО — Loom з'являється автоматично на сумісних відео.",
  "popup.statusOff": "ВИМКНЕНО — Loom ніде не працює, доки ви його знову не ввімкнете.",
  "popup.checkApi": "Перевірити API",
  "popup.checking": "Перевірка…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Помилка: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Вивчайте мови за серіалами, які ви й так дивитеся.",
  "onboarding.step1.title": "Відкрийте відео",
  "onboarding.step1.body":
    "Loom працює на {platforms} — будь-яке відео із субтитрами мовою, яку ви вивчаєте.",
  "onboarding.step2.title": "Натисніть пігулку Loom",
  "onboarding.step2.body":
    "У плеєрі з'являється невелика пігулка {pill}. Натисніть її, щоб активувати — кожна вкладка лишається вимкненою, доки ви не попросите.",
  "onboarding.step3.title": "Читайте всі чотири шари",
  "onboarding.step3.body":
    "Ваша мова, мова відео, фонетичний рядок і посимвольні читання (furigana, Pinyin та інші). Панель ⚙ на пігулці налаштовує все.",
  "onboarding.help.title": "Допомогти покращити Loom?",
  "onboarding.help.body":
    "Долучіться анонімними даними субтитрів: відео, які ви дивитеся, передають свій ідентифікатор та текст субтитрів до навчального корпусу Loom, щоб покращити анотації, романізацію та майбутню підтримку OCR. Це ніколи не пов'язується з вами — жодного облікового запису, жодної IP-адреси, жодних ідентифікаторів — а однаковий вміст зберігається лише раз, скільки б людей його не дивилося.",
  "onboarding.help.contribute": "Долучити дані субтитрів",
  "onboarding.help.decline": "Ні, дякую",
  "onboarding.help.thanks": "Дякуємо! Ви долучаєте дані субтитрів.",
  "onboarding.help.noProblem": "Нічого страшного — нічого не буде передано.",
  "onboarding.help.changeLater":
    "Ви можете змінити це будь-коли на панелі налаштувань ⚙ пігулки Loom.",
  "onboarding.privacyPolicy": "Політика конфіденційності",
  "onboarding.helpFaq": "Довідка та поширені запитання",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Налаштування Loom",
  "pill.discovering": "пошук…",
  "pill.noCaptions": "немає субтитрів",
  "pill.noSupportedTracks": "немає підтримуваних доріжок",
  "pill.error": "помилка (див. консоль)",
  "dormant.activate": "Активувати Loom на цій вкладці",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Допомогти покращити Loom?",
  "consent.body":
    "Долучіться анонімними даними субтитрів (ідентифікатор відео + текст субтитрів — ніколи нічого про вас), щоб покращити анотації та романізацію.",
  "consent.contribute": "Долучити",
  "consent.decline": "Ні, дякую",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Визначення слова {word}",
  "define.looking": "Пошук…",
  "define.unreachable": "Не вдалося зв'язатися зі словником.",
  "define.noEntry": "Немає словникової статті.",
  "define.breakdown": "Розбір",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (Типовий)",
  "preset.loominate.desc": "Типові пастельні кольори Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Підтримати Loom",
  "settings.title": "Налаштування Loom",
  "settings.close": "Закрити налаштування",
  "settings.feedback": "Надіслати відгук",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Мова користувача (основа для авто-вибору)",
  "settings.userLang.hint":
    "Авто-вибір збігається з будь-яким регіональним варіантом (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Мова відео (верхній) — {count} доріжок",
  "settings.bottomLang.title": "Мова користувача (нижній)",
  "settings.bottomLang.autoTranslate":
    "(авто: перекладати на {lang}, коли немає відповідної доріжки)",
  "settings.bottomLang.noAutoTranslate":
    "(немає — немає автоперекладу на {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Розташування",
  "settings.videoLang": "Мова відео",
  "settings.userLang": "Мова користувача",
  "settings.position.hint":
    "Слот 1 = верхній рядок у своїй зоні, слот 2 = нижній. Один рядок у зоні використовує типове розташування зони.",
  "settings.position.topNudge": "Верхній рядок — вертикальне зміщення",
  "settings.position.bottomNudge": "Нижній рядок — вертикальне зміщення",
  "settings.position.lineSpacing": "Міжрядковий інтервал",
  "settings.position.nudgeHint":
    "Зміщення пересуває рядок до центру зображення в міру його підняття (вниз для верхнього рядка, вгору для нижнього) — зручно, щоб відтягнути текст від чорних смуг на відео з леттербоксом. Написи та вертикальні репліки зберігають власне розташування. Зберігається окремо для кожної платформи.",
  "settings.pos.top1": "↑ Верх 1",
  "settings.pos.top2": "↑ Верх 2",
  "settings.pos.bot1": "↓ Низ 1",
  "settings.pos.bot2": "↓ Низ 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Розмір субтитрів",
  "settings.size.overall": "Загальний розмір",
  "settings.size.hint":
    "Масштабує всі рядки разом, поверх окремих розмірів рядків нижче. 100% відповідає налаштованому типовому значенню; зменшіть його, якщо субтитри тут відображаються завеликими (напр. Netflix у повноекранному режимі). Запам'ятовується окремо для кожної платформи.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Кольорові набори",
  "settings.preset.label": "Набір",
  "settings.preset.custom": "(власний)",
  "settings.preset.noPreset": "(немає набору — власні кольори)",
  "settings.preset.loading": "Завантаження наборів…",
  "settings.preset.none":
    "Немає доступних наборів — перемкніться на китайську, японську, корейську, тайську чи російську доріжку, щоб побачити тематичні мовні набори, або скористайтеся Classic на будь-якій доріжці.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Нижній — мова користувача",
  "settings.layer.showBottom": "Показувати нижній рядок",
  "settings.layer.top": "Верхній — мова відео",
  "settings.layer.showTop": "Показувати верхній рядок",
  "settings.layer.linkOpacity":
    "Пов'язати непрозорість (анотація, романізація, альтернативне написання)",
  "settings.layer.linkOpacityAria": "Пов'язати непрозорість верхньої групи",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Посимвольна анотація",
  "settings.annotation.userLangAdvanced": "Анотація мовою користувача",
  "settings.annotation.hint":
    "Дрібні читання над кожним символом — furigana для японської, Pinyin / Zhuyin / Jyutping для китайської, романізація для корейської. Доступно для китайської, японської та корейської. Розмір — це частка від верхнього рядка (0.5 = половина).",
  "settings.annotate.none": "Для цієї мови ще немає посимвольної анотації.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Романізація (фонетичний рядок)",
  "settings.romanization.userLangAdvanced": "Романізація мовою користувача",
  "settings.romanization.hint":
    "Повний рядок вимови над текстом відео. Доступно для китайського, японського, корейського, кириличного, тайського, індійського, івритського та арабського / перського / урду письма. Вибір стилю з'являється лише там, де є більше ніж один варіант. Розмір — це частка від батьківського рядка.",
  "settings.romanize.style": "Стиль романізації",
  "settings.romanize.auto": "Авто (типовий для мови)",
  "settings.romanize.none":
    "Немає рядка вимови для цієї мови (латинське письмо або не підтримується).",
  "settings.chooseTrack": "(спершу оберіть доріжку вище)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Японські довгі голосні",
  "settings.longVowel.macrons": "Макрони (tōkyō)",
  "settings.longVowel.doubled": "Подвоєні голосні (tookyoo)",
  "settings.longVowel.unmarked": "Без позначок (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Дані",
  "settings.data.contribute": "Долучити дані субтитрів",
  "settings.data.hint":
    "Надсилає субтитри відео, які ви дивитеся (назву/ідентифікатор відео та текст субтитрів — ніколи нічого про вас) до навчального корпусу Loom, щоб покращити анотації, романізацію та майбутню підтримку OCR.",
  "settings.turnOff": "Вимкнути Loom на цій вкладці",
  "settings.turnOff.hint":
    "Активуйте знову через невелику пігулку, що повертається після вимкнення. Зберігається між перезавантаженнями цієї вкладки.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Субтитри цього матеріалу — це зображення, а не текст, тож Loom не може їх прочитати. Спробуйте матеріал із текстовими субтитрами.",
  "settings.empty.noTracks": "На цьому відео немає підтримуваних доріжок субтитрів.",
  "settings.empty.discovering": "Пошук субтитрів…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Перекласти на",
  "settings.noTranslation": "(без перекладу)",
  "settings.track.auto": "(авто)",
  "settings.badge.auto": "авто",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "вручну",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Колір",
  "settings.font": "Шрифт",
  "settings.sizePx": "Розмір (px)",
  "settings.sizeRatio": "Розмір (частка від верхнього)",
  "settings.opacity": "Непрозорість",
  "settings.advanced": "Додатково",
  "settings.outlineColor": "Колір контуру",
  "settings.outlineAlpha": "Прозорість контуру",
  "settings.glowRadius": "Радіус сяйва (px)",
  "settings.glowNone": "0 = без сяйва",
  "settings.glowHalo": "ореол {n}px",
  "settings.glowColor": "Колір сяйва",
  "settings.glowAlpha": "Прозорість сяйва",
  "settings.colorWheel": "Відкрити колірне коло",
  "settings.setColor": "Встановити колір {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Авто (Noto + системний резервний)",
  "settings.font.systemSans": "Системний без засічок",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "без романізації",
  "settings.proc.latinNone": "Латиниця (без романізації)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Альтернативна орфографія",
  "settings.variant.highlightColors": "Підсвічування та кольори",
  "settings.variant.colorCode": "Кольорове кодування відмінних символів",
  "settings.variant.simpSameAsTop": "Спрощений символ: як у верхньому",
  "settings.variant.simpColor": "Колір спрощеного символу",
  "settings.variant.matchesTop": "збігається з верхнім",
  "settings.variant.distinctColor": "Колір розрізнюваного символу",
  "settings.variant.mergedColor": "Колір злитого символу",
  "settings.variant.preview": "Попередній перегляд",
  "settings.variant.distinct": "Розрізнюваний",
  "settings.variant.merged": "Злитий",
  "settings.variant.distinctHint":
    "традиційний символ має власну унікальну спрощену форму (語 → 语). Той, хто читає спрощений, може визначити, який традиційний малося на увазі.",
  "settings.variant.mergedHint":
    "кілька традиційних символів мають однакову спрощену форму (髮 і 發 обидва → 发). Оригінал втрачається — саме тут спрощення відкидає інформацію.",
  "settings.variant.none":
    "У цій збірці немає варіанта орфографії. Наразі підтримується лише традиційна китайська (zh-Hant / zh-TW / zh-HK / zh-MO / yue).",
};
