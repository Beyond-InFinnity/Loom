import type { LocaleTable } from "./en";

// Polish (Polski) UI strings. Keys and {param} placeholders match en.ts.
// "Loom" stays undeclined; counts and inserted words sit after a colon or in
// the nominative so no placeholder needs Polish case or plural agreement.
export const pl: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Podwójne napisy do filmów w obcych językach.",
  "popup.enableLabel": "Loom w tej przeglądarce",
  "popup.turnOff": "Wyłącz Loom",
  "popup.turnOn": "Włącz Loom",
  "popup.statusOn": "WŁĄCZONY — Loom pojawia się automatycznie w zgodnych filmach.",
  "popup.statusOff": "WYŁĄCZONY — Loom nie działa nigdzie, dopóki go ponownie nie włączysz.",
  "popup.checkApi": "Sprawdź API",
  "popup.checking": "Sprawdzanie…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Błąd: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Ucz się języków z seriali, które już oglądasz.",
  "onboarding.step1.title": "Otwórz film",
  "onboarding.step1.body":
    "Loom działa w serwisach {platforms} — w każdym filmie z napisami w języku, którego się uczysz.",
  "onboarding.step2.title": "Kliknij pigułkę Loom",
  "onboarding.step2.body":
    "W odtwarzaczu pojawia się mała pigułka {pill}. Kliknij ją, aby włączyć — każda karta pozostaje wyłączona, dopóki o to nie poprosisz.",
  "onboarding.step3.title": "Czytaj wszystkie cztery warstwy",
  "onboarding.step3.body":
    "Twój język, język filmu, linia fonetyczna i odczyty poszczególnych znaków (furigana, Pinyin i inne). Panel ⚙ na pigułce pozwala dostosować wszystko.",
  "onboarding.help.title": "Pomożesz ulepszyć Loom?",
  "onboarding.help.body":
    "Przekazuj anonimowe dane napisów: oglądane przez ciebie filmy udostępniają swój identyfikator i tekst napisów korpusowi treningowemu Loom, aby ulepszyć adnotacje, latynizację i przyszłą obsługę OCR. Dane nigdy nie są powiązane z tobą — bez konta, bez adresu IP, bez identyfikatorów — a identyczna treść jest przechowywana tylko raz, niezależnie od tego, ile osób ją ogląda.",
  "onboarding.help.contribute": "Przekazuj dane napisów",
  "onboarding.help.decline": "Nie, dziękuję",
  "onboarding.help.thanks": "Dziękujemy! Przekazujesz dane napisów.",
  "onboarding.help.noProblem": "Nie ma sprawy — nic nie zostanie udostępnione.",
  "onboarding.help.changeLater":
    "Możesz to zmienić w dowolnym momencie w panelu ustawień ⚙ pigułki Loom.",
  "onboarding.privacyPolicy": "Polityka prywatności",
  "onboarding.helpFaq": "Pomoc i FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Ustawienia Loom",
  "pill.discovering": "wyszukiwanie…",
  "pill.noCaptions": "brak napisów",
  "pill.noSupportedTracks": "brak obsługiwanych ścieżek",
  "pill.error": "błąd (zobacz konsolę)",
  "dormant.activate": "Włącz Loom w tej karcie",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Pomożesz ulepszyć Loom?",
  "consent.body":
    "Przekazuj anonimowe dane napisów (identyfikator filmu + tekst napisów — nigdy nic o tobie), aby ulepszyć adnotacje i latynizację.",
  "consent.contribute": "Przekazuj",
  "consent.decline": "Nie, dziękuję",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Definicja: {word}",
  "define.looking": "Wyszukiwanie…",
  "define.unreachable": "Nie udało się połączyć ze słownikiem.",
  "define.noEntry": "Brak hasła w słowniku.",
  "define.breakdown": "Rozbiór",
  "define.grammar": "Gramatyka",
  "define.glossLanguage": "Język słownika",
  "define.glossAuto": "Automatycznie",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (domyślny)",
  "preset.loominate.desc": "Domyślne pastelowe kolory Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Wesprzyj Loom",
  "settings.title": "Ustawienia Loom",
  "settings.close": "Zamknij ustawienia",
  "settings.feedback": "Wyślij opinię",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Język użytkownika (podstawa automatycznego wyboru)",
  "settings.userLang.hint":
    "Automatyczny wybór dopasowuje każdy wariant regionalny (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Język filmu (Góra) — ścieżki: {count}",
  "settings.bottomLang.title": "Język użytkownika (Dół)",
  "settings.bottomLang.autoTranslate":
    "(auto: tłumacz na {lang}, gdy brak pasującej ścieżki)",
  "settings.bottomLang.noAutoTranslate":
    "(brak — {platform} nie oferuje automatycznego tłumaczenia)",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Pozycja",
  "settings.videoLang": "Język filmu",
  "settings.userLang": "Język użytkownika",
  "settings.position.hint":
    "Miejsce 1 = górna linia w swojej strefie, miejsce 2 = dolna. Linia sama w strefie używa domyślnej pozycji strefy.",
  "settings.position.topNudge": "Górna linia — przesunięcie w pionie",
  "settings.position.bottomNudge": "Dolna linia — przesunięcie w pionie",
  "settings.position.lineSpacing": "Odstęp między liniami",
  "settings.position.annotationSpacing": "Odstęp adnotacji",
  "settings.position.nudgeHint":
    "Przesunięcie zbliża linię do środka obrazu w miarę zwiększania wartości (w dół dla górnej linii, w górę dla dolnej) — przydaje się, by zdjąć tekst z czarnych pasów w filmach w formacie letterbox. Napisy-plansze i napisy pionowe zachowują własną pozycję. Zapisywane osobno dla każdej platformy.",
  "settings.pos.top1": "↑ Góra 1",
  "settings.pos.top2": "↑ Góra 2",
  "settings.pos.bot1": "↓ Dół 1",
  "settings.pos.bot2": "↓ Dół 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Rozmiar napisów",
  "settings.size.overall": "Rozmiar ogólny",
  "settings.size.hint":
    "Skaluje wszystkie linie razem, dodatkowo względem rozmiarów poszczególnych linii poniżej. 100% odpowiada dopracowanemu ustawieniu domyślnemu; zmniejsz, jeśli napisy wyświetlają się tu za duże (np. Netflix na pełnym ekranie). Zapamiętywane osobno dla każdej platformy.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Szablony kolorów",
  "settings.preset.label": "Szablon",
  "settings.preset.custom": "(własny)",
  "settings.preset.noPreset": "(bez szablonu — własne kolory)",
  "settings.preset.loading": "Wczytywanie szablonów…",
  "settings.preset.none":
    "Brak dostępnych szablonów — przełącz na ścieżkę chińską, japońską, koreańską, tajską lub rosyjską, aby zobaczyć szablony tematyczne dla danego języka, albo użyj Classic na dowolnej ścieżce.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Dół — język użytkownika",
  "settings.layer.showBottom": "Pokaż dolną linię",
  "settings.layer.top": "Góra — język filmu",
  "settings.layer.showTop": "Pokaż górną linię",
  "settings.layer.linkOpacity":
    "Powiąż krycie (adnotacja, latynizacja, alternatywna pisownia)",
  "settings.layer.linkOpacityAria": "Powiąż krycie grupy górnej",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Adnotacja dla każdego znaku",
  "settings.annotation.userLangAdvanced": "Adnotacja w języku użytkownika",
  "settings.annotation.hint":
    "Małe odczyty nad każdym znakiem — furigana dla japońskiego, Pinyin / Zhuyin / Jyutping dla chińskiego, latynizacja dla koreańskiego. Dostępne dla chińskiego, japońskiego i koreańskiego. Rozmiar to ułamek linii Góra (0,5 = połowa).",
  "settings.annotate.none": "Brak jeszcze adnotacji dla poszczególnych znaków w tym języku.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Latynizacja (linia fonetyczna)",
  "settings.romanization.userLangAdvanced": "Latynizacja języka użytkownika",
  "settings.romanization.hint":
    "Pełna linia wymowy nad tekstem filmu. Dostępna dla chińskiego, japońskiego, koreańskiego oraz pism cyrylickiego, tajskiego, indyjskich, hebrajskiego i arabskiego / perskiego / urdu. Wybór stylu pojawia się tylko tam, gdzie jest więcej niż jedna opcja. Rozmiar to ułamek linii nadrzędnej.",
  "settings.romanize.style": "Styl latynizacji",
  "settings.romanize.auto": "Auto (domyślny dla języka)",
  "settings.romanize.none":
    "Brak linii wymowy dla tego języka (pismo łacińskie lub nieobsługiwane).",
  "settings.chooseTrack": "(najpierw wybierz ścieżkę powyżej)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Długie samogłoski w japońskim",
  "settings.longVowel.macrons": "Makrony (tōkyō)",
  "settings.longVowel.doubled": "Podwojone samogłoski (tookyoo)",
  "settings.longVowel.unmarked": "Bez oznaczeń (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Dane",
  "settings.data.contribute": "Przekazuj dane napisów",
  "settings.data.hint":
    "Wysyła napisy oglądanych filmów (tytuł/identyfikator filmu i tekst napisów — nigdy nic o tobie) do korpusu treningowego Loom, aby ulepszyć adnotacje, latynizację i przyszłą obsługę OCR.",
  "settings.turnOff": "Wyłącz Loom w tej karcie",
  "settings.turnOff.hint":
    "Włącz ponownie małą pigułką, która pojawia się po wyłączeniu. Ustawienie utrzymuje się po przeładowaniu tej karty.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Napisy do tego tytułu są obrazami, a nie tekstem, więc Loom nie może ich odczytać. Wypróbuj tytuł z napisami tekstowymi.",
  "settings.empty.noTracks": "Brak obsługiwanych ścieżek napisów w tym filmie.",
  "settings.empty.discovering": "Wyszukiwanie napisów…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Tłumacz na",
  "settings.noTranslation": "(bez tłumaczenia)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "ręczne",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Kolor",
  "settings.font": "Czcionka",
  "settings.sizePx": "Rozmiar (px)",
  "settings.sizeRatio": "Rozmiar (ułamek Góry)",
  "settings.opacity": "Krycie",
  "settings.advanced": "Zaawansowane",
  "settings.outlineColor": "Kolor obrysu",
  "settings.outlineAlpha": "Alfa obrysu",
  "settings.glowRadius": "Promień poświaty (px)",
  "settings.glowNone": "0 = bez poświaty",
  "settings.glowHalo": "Poświata {n}px",
  "settings.glowColor": "Kolor poświaty",
  "settings.glowAlpha": "Alfa poświaty",
  "settings.colorWheel": "Otwórz koło kolorów",
  "settings.setColor": "Ustaw kolor {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + czcionka zapasowa systemu)",
  "settings.font.systemSans": "Systemowa bezszeryfowa",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "bez latynizacji",
  "settings.proc.latinNone": "Łacińskie (bez latynizacji)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Alternatywna pisownia",
  "settings.variant.highlightColors": "Wyróżnienie i kolory",
  "settings.variant.colorCode": "Koloruj różniące się znaki",
  "settings.variant.simpSameAsTop": "Znak uproszczony: zgodny z Górą",
  "settings.variant.simpColor": "Kolor znaku uproszczonego",
  "settings.variant.matchesTop": "zgodny z Górą",
  "settings.variant.distinctColor": "Kolor znaku odrębnego",
  "settings.variant.mergedColor": "Kolor znaku scalonego",
  "settings.variant.preview": "Podgląd",
  "settings.variant.distinct": "Odrębny",
  "settings.variant.merged": "Scalony",
  "settings.variant.distinctHint":
    "znak tradycyjny ma własną, unikalną formę uproszczoną (語 → 语). Czytający wersję uproszczoną może rozpoznać, o który znak tradycyjny chodziło.",
  "settings.variant.mergedHint":
    "kilka znaków tradycyjnych ma tę samą formę uproszczoną (髮 i 發 → oba 发). Oryginał ginie — właśnie w tym miejscu uproszczenie traci informację.",
  "settings.variant.none":
    "brak wariantu pisowni w tej wersji. Obecnie obsługiwany jest tylko chiński tradycyjny (zh-Hant / zh-TW / zh-HK / zh-MO / yue).",
};
