import type { LocaleTable } from "./en";

// Italian (Italiano) UI strings. Keys and {param} placeholders match en.ts.
export const it: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Sottotitoli doppi per i video in lingua straniera.",
  "popup.enableLabel": "Loom su questo browser",
  "popup.turnOff": "Disattiva Loom",
  "popup.turnOn": "Attiva Loom",
  "popup.statusOn": "ATTIVO — Loom compare automaticamente sui video compatibili.",
  "popup.statusOff": "DISATTIVO — Loom non funziona da nessuna parte finché non lo riattivi.",
  "popup.checkApi": "Verifica API",
  "popup.checking": "Verifica in corso…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Errore: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Impara le lingue dalle serie che già guardi.",
  "onboarding.step1.title": "Apri un video",
  "onboarding.step1.body":
    "Loom funziona su {platforms} — qualsiasi video con sottotitoli nella lingua che stai imparando.",
  "onboarding.step2.title": "Clicca sulla pillola Loom",
  "onboarding.step2.body":
    "Nel player compare una piccola pillola {pill}. Cliccala per attivarla — ogni scheda resta disattivata finché non lo chiedi tu.",
  "onboarding.step3.title": "Leggi tutti e quattro i livelli",
  "onboarding.step3.body":
    "La tua lingua, la lingua del video, una linea fonetica e le letture per ogni carattere (furigana, Pinyin e altro). Il pannello ⚙ sulla pillola personalizza tutto.",
  "onboarding.help.title": "Vuoi aiutare a migliorare Loom?",
  "onboarding.help.body":
    "Contribuisci con dati anonimi sui sottotitoli: i video che guardi condividono il loro ID video e il testo dei sottotitoli con il corpus di addestramento di Loom per migliorare annotazioni, romanizzazione e il futuro supporto OCR. Non è mai collegato a te — niente account, niente indirizzo IP, nessun identificatore — e i contenuti identici vengono memorizzati una sola volta, a prescindere da quante persone li guardano.",
  "onboarding.help.contribute": "Contribuisci con i dati dei sottotitoli",
  "onboarding.help.decline": "No, grazie",
  "onboarding.help.thanks": "Grazie! Stai contribuendo con i dati dei sottotitoli.",
  "onboarding.help.noProblem": "Nessun problema — non verrà condiviso nulla.",
  "onboarding.help.changeLater":
    "Puoi modificarlo in qualsiasi momento nel pannello impostazioni ⚙ della pillola Loom.",
  "onboarding.privacyPolicy": "Informativa sulla privacy",
  "onboarding.helpFaq": "Aiuto e FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Impostazioni Loom",
  "pill.discovering": "ricerca in corso…",
  "pill.noCaptions": "nessun sottotitolo",
  "pill.noSupportedTracks": "nessuna traccia supportata",
  "pill.error": "errore (vedi console)",
  "dormant.activate": "Attiva Loom su questa scheda",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Vuoi aiutare a migliorare Loom?",
  "consent.body":
    "Contribuisci con dati anonimi sui sottotitoli (ID video + testo dei sottotitoli — mai nulla che ti riguardi) per migliorare annotazioni e romanizzazione.",
  "consent.contribute": "Contribuisci",
  "consent.decline": "No, grazie",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Definizione di {word}",
  "define.looking": "Ricerca in corso…",
  "define.unreachable": "Impossibile raggiungere il dizionario.",
  "define.noEntry": "Nessuna voce nel dizionario.",
  "define.breakdown": "Scomposizione",
  "define.grammar": "Grammatica",
  "define.glossLanguage": "Lingua del dizionario",
  "define.glossAuto": "Automatico",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (predefinito)",
  "preset.loominate.desc": "I colori pastello predefiniti di Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Sostieni Loom",
  "settings.title": "Impostazioni Loom",
  "settings.close": "Chiudi le impostazioni",
  "settings.feedback": "Invia un feedback",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Lingua dell'utente (base per la scelta automatica)",
  "settings.userLang.hint":
    "La scelta automatica riconosce qualsiasi variante regionale (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Lingua del video (in alto) — {count} tracce",
  "settings.bottomLang.title": "Lingua dell'utente (in basso)",
  "settings.bottomLang.autoTranslate":
    "(auto: traduci in {lang} quando non c'è una traccia corrispondente)",
  "settings.bottomLang.noAutoTranslate":
    "(nessuna — nessuna traduzione automatica su {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Posizione",
  "settings.videoLang": "Lingua del video",
  "settings.userLang": "Lingua dell'utente",
  "settings.position.hint":
    "Slot 1 = linea superiore nella sua zona, slot 2 = inferiore. Se è da sola in una zona, usa la posizione predefinita della zona.",
  "settings.position.topNudge": "Linea superiore — spostamento verticale",
  "settings.position.bottomNudge": "Linea inferiore — spostamento verticale",
  "settings.position.lineSpacing": "Interlinea",
  "settings.position.annotationSpacing": "Spaziatura annotazione",
  "settings.position.nudgeHint":
    "Lo spostamento avvicina una linea al centro dell'immagine man mano che la alzi (verso il basso per la linea superiore, verso l'alto per quella inferiore) — utile per staccare il testo dalle barre nere nei video in letterbox. Le scritte e i sottotitoli verticali mantengono la loro posizione. Salvato per ogni piattaforma.",
  "settings.pos.top1": "↑ Alto 1",
  "settings.pos.top2": "↑ Alto 2",
  "settings.pos.bot1": "↓ Basso 1",
  "settings.pos.bot2": "↓ Basso 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Dimensione dei sottotitoli",
  "settings.size.overall": "Dimensione complessiva",
  "settings.size.hint":
    "Ridimensiona tutte le linee insieme, oltre alle dimensioni per linea qui sotto. 100% corrisponde al valore predefinito ottimizzato; abbassalo se qui i sottotitoli appaiono grandi (ad es. Netflix a schermo intero). Memorizzato separatamente per ogni piattaforma.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Preset di colori",
  "settings.preset.label": "Preset",
  "settings.preset.custom": "(personalizzato)",
  "settings.preset.noPreset": "(nessun preset — colori personalizzati)",
  "settings.preset.loading": "Caricamento dei preset…",
  "settings.preset.none":
    "Nessun preset disponibile — passa a una traccia in cinese, giapponese, coreano, thai o russo per vedere i preset a tema linguistico, oppure usa Classic su qualsiasi traccia.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "In basso — lingua dell'utente",
  "settings.layer.showBottom": "Mostra la linea inferiore",
  "settings.layer.top": "In alto — lingua del video",
  "settings.layer.showTop": "Mostra la linea superiore",
  "settings.layer.linkOpacity":
    "Collega l'opacità (annotazione, romanizzazione, ortografia alternativa)",
  "settings.layer.linkOpacityAria": "Collega l'opacità del gruppo in alto",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Annotazione per carattere",
  "settings.annotation.userLangAdvanced": "Annotazione della lingua dell'utente",
  "settings.annotation.hint":
    "Piccole letture sopra ogni carattere — furigana per il giapponese, Pinyin / Zhuyin / Jyutping per il cinese, romanizzazione per il coreano. Disponibile per cinese, giapponese e coreano. La dimensione è una frazione della linea superiore (0,5 = metà).",
  "settings.annotate.none": "Ancora nessuna annotazione per carattere per questa lingua.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Romanizzazione (linea fonetica)",
  "settings.romanization.userLangAdvanced": "Romanizzazione della lingua dell'utente",
  "settings.romanization.hint":
    "Una linea di pronuncia completa sopra il testo del video. Disponibile per cinese, giapponese, coreano, cirillico, thai, scritture indiane, ebraico e arabo / persiano / urdu. Il selettore dello stile compare solo quando c'è più di un'opzione. La dimensione è una frazione della linea superiore.",
  "settings.romanize.style": "Stile di romanizzazione",
  "settings.romanize.auto": "Auto (predefinito per la lingua)",
  "settings.romanize.none":
    "Nessuna linea di pronuncia per questa lingua (scrittura latina o non supportata).",
  "settings.chooseTrack": "(scegli prima una traccia qui sopra)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Vocali lunghe giapponesi",
  "settings.longVowel.macrons": "Macron (tōkyō)",
  "settings.longVowel.doubled": "Vocali doppie (tookyoo)",
  "settings.longVowel.unmarked": "Senza segni (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Dati",
  "settings.data.contribute": "Contribuisci con i dati dei sottotitoli",
  "settings.data.hint":
    "Invia i sottotitoli dei video che guardi (titolo/ID del video e testo dei sottotitoli — mai nulla che ti riguardi) al corpus di addestramento di Loom per migliorare annotazioni, romanizzazione e il futuro supporto OCR.",
  "settings.turnOff": "Disattiva Loom su questa scheda",
  "settings.turnOff.hint":
    "Riattivalo tramite la piccola pillola che ricompare quando lo disattivi. Persiste ai ricaricamenti di questa scheda.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "I sottotitoli di questo titolo sono immagini, non testo, quindi Loom non può leggerli. Prova un titolo con sottotitoli in formato testo.",
  "settings.empty.noTracks": "Nessuna traccia di sottotitoli supportata su questo video.",
  "settings.empty.discovering": "Ricerca dei sottotitoli in corso…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Traduci in",
  "settings.noTranslation": "(nessuna traduzione)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "manuale",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Colore",
  "settings.font": "Font",
  "settings.sizePx": "Dimensione (px)",
  "settings.sizeRatio": "Dimensione (frazione della linea superiore)",
  "settings.opacity": "Opacità",
  "settings.advanced": "Avanzate",
  "settings.outlineColor": "Colore del contorno",
  "settings.outlineAlpha": "Alfa del contorno",
  "settings.glowRadius": "Raggio del bagliore (px)",
  "settings.glowNone": "0 = nessun bagliore",
  "settings.glowHalo": "alone di {n}px",
  "settings.glowColor": "Colore del bagliore",
  "settings.glowAlpha": "Alfa del bagliore",
  "settings.colorWheel": "Apri la ruota dei colori",
  "settings.setColor": "Imposta il colore su {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + fallback di sistema)",
  "settings.font.systemSans": "Sans-serif di sistema",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "nessuna romanizzazione",
  "settings.proc.latinNone": "Latino (nessuna romanizzazione)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Ortografia alternativa",
  "settings.variant.highlightColors": "Evidenziazione e colori",
  "settings.variant.colorCode": "Colora i caratteri diversi",
  "settings.variant.simpSameAsTop": "Carattere semplificato: come in alto",
  "settings.variant.simpColor": "Colore del carattere semplificato",
  "settings.variant.matchesTop": "come in alto",
  "settings.variant.distinctColor": "Colore del carattere distinto",
  "settings.variant.mergedColor": "Colore del carattere unito",
  "settings.variant.preview": "Anteprima",
  "settings.variant.distinct": "Distinto",
  "settings.variant.merged": "Unito",
  "settings.variant.distinctHint":
    "il carattere tradizionale ha una propria forma semplificata, unica (語 → 语). Chi legge il semplificato può capire quale tradizionale era inteso.",
  "settings.variant.mergedHint":
    "più caratteri tradizionali condividono la stessa forma semplificata (髮 e 發 diventano entrambi → 发). L'originale va perso — è qui che la semplificazione butta via informazioni.",
  "settings.variant.none":
    "Nessuna variante ortografica in questa build. Al momento è supportato solo il cinese tradizionale (zh-Hant / zh-TW / zh-HK / zh-MO / yue).",
} as const satisfies Record<string, string>;
