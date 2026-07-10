import type { LocaleTable } from "./en";

// German (Deutsch) UI strings. Keys and {param} placeholders match en.ts.
export const de: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Zweisprachige Untertitel für fremdsprachige Videos.",
  "popup.enableLabel": "Loom in diesem Browser",
  "popup.turnOff": "Loom ausschalten",
  "popup.turnOn": "Loom einschalten",
  "popup.statusOn": "AN — Loom erscheint automatisch bei kompatiblen Videos.",
  "popup.statusOff": "AUS — Loom läuft nirgends, bis du es wieder einschaltest.",
  "popup.checkApi": "API prüfen",
  "popup.checking": "Wird geprüft…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Fehler: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Lerne Sprachen mit den Serien, die du ohnehin schaust.",
  "onboarding.step1.title": "Öffne ein Video",
  "onboarding.step1.body":
    "Loom funktioniert auf {platforms} — bei jedem Video mit Untertiteln in der Sprache, die du lernst.",
  "onboarding.step2.title": "Klick auf die Loom-Pille",
  "onboarding.step2.body":
    "Eine kleine {pill}-Pille erscheint im Player. Klick sie an, um zu aktivieren — jeder Tab bleibt aus, bis du es möchtest.",
  "onboarding.step3.title": "Lies alle vier Ebenen",
  "onboarding.step3.body":
    "Deine Sprache, die Sprache des Videos, eine Lautschrift-Zeile und Lesungen pro Zeichen (furigana, Pinyin und mehr). Das ⚙-Panel an der Pille passt alles an.",
  "onboarding.help.title": "Hilf mit, Loom zu verbessern?",
  "onboarding.help.body":
    "Trage anonyme Untertiteldaten bei: Die Videos, die du schaust, teilen ihre Video-ID und ihren Untertiteltext mit Looms Trainingskorpus, um Annotationen, Romanisierung und künftige OCR-Unterstützung zu verbessern. Es wird nie mit dir verknüpft — kein Konto, keine IP-Adresse, keine Kennungen — und identische Inhalte werden nur einmal gespeichert, egal wie viele Leute sie ansehen.",
  "onboarding.help.contribute": "Untertiteldaten beitragen",
  "onboarding.help.decline": "Nein danke",
  "onboarding.help.thanks": "Danke! Du trägst Untertiteldaten bei.",
  "onboarding.help.noProblem": "Kein Problem — es wird nichts geteilt.",
  "onboarding.help.changeLater":
    "Du kannst das jederzeit im ⚙-Einstellungspanel der Loom-Pille ändern.",
  "onboarding.privacyPolicy": "Datenschutzerklärung",
  "onboarding.helpFaq": "Hilfe & FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom-Einstellungen",
  "pill.discovering": "wird gesucht…",
  "pill.noCaptions": "keine Untertitel",
  "pill.noSupportedTracks": "keine unterstützten Spuren",
  "pill.error": "Fehler (siehe Konsole)",
  "dormant.activate": "Loom in diesem Tab aktivieren",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Hilf mit, Loom zu verbessern?",
  "consent.body":
    "Trage anonyme Untertiteldaten bei (Video-ID + Untertiteltext — nie etwas über dich), um Annotationen und Romanisierung zu verbessern.",
  "consent.contribute": "Beitragen",
  "consent.decline": "Nein danke",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Definition von {word}",
  "define.looking": "Wird nachgeschlagen…",
  "define.unreachable": "Das Wörterbuch war nicht erreichbar.",
  "define.noEntry": "Kein Wörterbucheintrag.",
  "define.breakdown": "Aufschlüsselung",
  "define.grammar": "Grammatik",
  "define.glossLanguage": "Wörterbuchsprache",
  "define.glossAuto": "Automatisch",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (Standard)",
  "preset.loominate.desc": "Looms Standard-Pastellfarben.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Loom unterstützen",
  "settings.title": "Loom-Einstellungen",
  "settings.close": "Einstellungen schließen",
  "settings.feedback": "Feedback senden",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Nutzersprache (Basis für Auto-Auswahl)",
  "settings.userLang.hint":
    "Die Auto-Auswahl passt zu jeder regionalen Variante (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Videosprache (Oben) — {count} Spuren",
  "settings.bottomLang.title": "Nutzersprache (Unten)",
  "settings.bottomLang.autoTranslate":
    "(auto: nach {lang} übersetzen, wenn keine passende Spur vorhanden)",
  "settings.bottomLang.noAutoTranslate":
    "(keine — keine automatische Übersetzung auf {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Position",
  "settings.videoLang": "Videosprache",
  "settings.userLang": "Nutzersprache",
  "settings.position.hint":
    "Platz 1 = obere Zeile in ihrer Zone, Platz 2 = untere. Allein in einer Zone gilt die Standardposition der Zone.",
  "settings.position.topNudge": "Obere Zeile — vertikal verschieben",
  "settings.position.bottomNudge": "Untere Zeile — vertikal verschieben",
  "settings.position.lineSpacing": "Zeilenabstand",
  "settings.position.nudgeHint":
    "Das Verschieben rückt eine Zeile zur Bildmitte, wenn du sie anhebst (nach unten für die obere Zeile, nach oben für die untere) — praktisch, um Text von den schwarzen Balken bei Letterbox-Videos wegzuziehen. Schilder und vertikale Einblendungen behalten ihre eigene Position. Wird pro Plattform gespeichert.",
  "settings.pos.top1": "↑ Oben 1",
  "settings.pos.top2": "↑ Oben 2",
  "settings.pos.bot1": "↓ Unten 1",
  "settings.pos.bot2": "↓ Unten 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Untertitelgröße",
  "settings.size.overall": "Gesamtgröße",
  "settings.size.hint":
    "Skaliert alle Zeilen gemeinsam, zusätzlich zu den Größen pro Zeile unten. 100 % entspricht dem abgestimmten Standard; verringere den Wert, wenn die Untertitel hier zu groß erscheinen (z. B. Netflix im Vollbild). Wird für jede Plattform separat gemerkt.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Farbvorlagen",
  "settings.preset.label": "Vorlage",
  "settings.preset.custom": "(benutzerdefiniert)",
  "settings.preset.noPreset": "(keine Vorlage — benutzerdefinierte Farben)",
  "settings.preset.loading": "Vorlagen werden geladen…",
  "settings.preset.none":
    "Keine Vorlagen verfügbar — wechsle zu einer chinesischen, japanischen, koreanischen, thailändischen oder russischen Spur, um sprachspezifische Vorlagen zu sehen, oder verwende Classic bei jeder Spur.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Unten — Nutzersprache",
  "settings.layer.showBottom": "Untere Zeile anzeigen",
  "settings.layer.top": "Oben — Videosprache",
  "settings.layer.showTop": "Obere Zeile anzeigen",
  "settings.layer.linkOpacity":
    "Deckkraft koppeln (Annotation, Romanisierung, Alt-Schreibweise)",
  "settings.layer.linkOpacityAria": "Deckkraft der Oben-Gruppe koppeln",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Annotation pro Zeichen",
  "settings.annotation.userLangAdvanced": "Annotation der Nutzersprache",
  "settings.annotation.hint":
    "Kleine Lesungen über jedem Zeichen — furigana für Japanisch, Pinyin / Zhuyin / Jyutping für Chinesisch, Romanisierung für Koreanisch. Verfügbar für Chinesisch, Japanisch und Koreanisch. Die Größe ist ein Bruchteil der oberen Zeile (0,5 = halb).",
  "settings.annotate.none": "Für diese Sprache gibt es noch keine Annotation pro Zeichen.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Romanisierung (Lautschrift-Zeile)",
  "settings.romanization.userLangAdvanced": "Romanisierung der Nutzersprache",
  "settings.romanization.hint":
    "Eine vollständige Aussprachezeile über dem Text des Videos. Verfügbar für Chinesisch, Japanisch, Koreanisch, Kyrillisch, Thai, indische Schriften, Hebräisch sowie Arabisch / Persisch / Urdu. Die Stil-Auswahl erscheint nur dort, wo es mehr als eine Option gibt. Die Größe ist ein Bruchteil der übergeordneten Zeile.",
  "settings.romanize.style": "Romanisierungsstil",
  "settings.romanize.auto": "Auto (Standard für die Sprache)",
  "settings.romanize.none":
    "Keine Aussprachezeile für diese Sprache (lateinische Schrift oder nicht unterstützt).",
  "settings.chooseTrack": "(wähle zuerst oben eine Spur)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Japanische Langvokale",
  "settings.longVowel.macrons": "Makrons (tōkyō)",
  "settings.longVowel.doubled": "Doppelvokale (tookyoo)",
  "settings.longVowel.unmarked": "Ohne Kennzeichnung (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Daten",
  "settings.data.contribute": "Untertiteldaten beitragen",
  "settings.data.hint":
    "Sendet die Untertitel der Videos, die du schaust (Videotitel/-ID und Untertiteltext — nie etwas über dich), an Looms Trainingskorpus, um Annotationen, Romanisierung und künftige OCR-Unterstützung zu verbessern.",
  "settings.turnOff": "Loom in diesem Tab ausschalten",
  "settings.turnOff.hint":
    "Reaktiviere es über die kleine Pille, die zurückkehrt, wenn du es ausschaltest. Bleibt über Neuladen dieses Tabs hinweg erhalten.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Die Untertitel dieses Titels sind Bilder, kein Text, daher kann Loom sie nicht lesen. Probier einen Titel mit textbasierten Untertiteln.",
  "settings.empty.noTracks": "Keine unterstützten Untertitelspuren bei diesem Video.",
  "settings.empty.discovering": "Untertitel werden gesucht…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Übersetzen nach",
  "settings.noTranslation": "(keine Übersetzung)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "manuell",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Farbe",
  "settings.font": "Schriftart",
  "settings.sizePx": "Größe (px)",
  "settings.sizeRatio": "Größe (Anteil von Oben)",
  "settings.opacity": "Deckkraft",
  "settings.advanced": "Erweitert",
  "settings.outlineColor": "Konturfarbe",
  "settings.outlineAlpha": "Kontur-Deckkraft",
  "settings.glowRadius": "Glühradius (px)",
  "settings.glowNone": "0 = kein Glühen",
  "settings.glowHalo": "{n}px Halo",
  "settings.glowColor": "Glühfarbe",
  "settings.glowAlpha": "Glüh-Deckkraft",
  "settings.colorWheel": "Farbkreis öffnen",
  "settings.setColor": "Farbe auf {hex} setzen",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + System-Fallback)",
  "settings.font.systemSans": "System-Sans-Serif",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "keine Romanisierung",
  "settings.proc.latinNone": "Lateinisch (keine Romanisierung)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Alternative Schreibweise",
  "settings.variant.highlightColors": "Hervorhebung & Farben",
  "settings.variant.colorCode": "Abweichende Zeichen farblich kennzeichnen",
  "settings.variant.simpSameAsTop": "Vereinfachtes Zeichen: wie Oben",
  "settings.variant.simpColor": "Farbe für vereinfachtes Zeichen",
  "settings.variant.matchesTop": "entspricht Oben",
  "settings.variant.distinctColor": "Farbe für eindeutige Zeichen",
  "settings.variant.mergedColor": "Farbe für zusammengeführte Zeichen",
  "settings.variant.preview": "Vorschau",
  "settings.variant.distinct": "Eindeutig",
  "settings.variant.merged": "Zusammengeführt",
  "settings.variant.distinctHint":
    "das traditionelle Zeichen hat eine eigene, eindeutige vereinfachte Form (語 → 语). Wer das Vereinfachte liest, könnte erkennen, welches traditionelle gemeint war.",
  "settings.variant.mergedHint":
    "mehrere traditionelle Zeichen teilen sich dieselbe vereinfachte Form (髮 und 發 beide → 发). Das Original geht verloren — genau hier wirft die Vereinfachung Information weg.",
  "settings.variant.none":
    "Keine Schreibweisen-Variante in diesem Build. Derzeit wird nur traditionelles Chinesisch (zh-Hant / zh-TW / zh-HK / zh-MO / yue) unterstützt.",
};
