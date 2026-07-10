import type { LocaleTable } from "./en";

// Spanish (Español) UI strings. Keys and {param} placeholders match en.ts.
export const es: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Subtítulos dobles para videos en idiomas extranjeros.",
  "popup.enableLabel": "Loom en este navegador",
  "popup.turnOff": "Desactivar Loom",
  "popup.turnOn": "Activar Loom",
  "popup.statusOn": "ACTIVADO — Loom aparece automáticamente en los videos compatibles.",
  "popup.statusOff": "DESACTIVADO — Loom no se ejecuta en ningún sitio hasta que vuelvas a activarlo.",
  "popup.checkApi": "Comprobar API",
  "popup.checking": "Comprobando…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Error: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Aprende idiomas con las series que ya ves.",
  "onboarding.step1.title": "Abre un video",
  "onboarding.step1.body":
    "Loom funciona en {platforms} — cualquier video con subtítulos en el idioma que estás aprendiendo.",
  "onboarding.step2.title": "Haz clic en la pastilla de Loom",
  "onboarding.step2.body":
    "Aparece una pequeña pastilla {pill} en el reproductor. Haz clic en ella para activarla — cada pestaña permanece inactiva hasta que tú lo pidas.",
  "onboarding.step3.title": "Lee las cuatro capas",
  "onboarding.step3.body":
    "Tu idioma, el idioma del video, una línea fonética y las lecturas por carácter (furigana, Pinyin y más). El panel ⚙ de la pastilla lo personaliza todo.",
  "onboarding.help.title": "¿Quieres ayudar a mejorar Loom?",
  "onboarding.help.body":
    "Contribuye con datos de subtítulos anónimos: los videos que ves comparten su ID de video y el texto de los subtítulos con el corpus de entrenamiento de Loom para mejorar las anotaciones, la romanización y el futuro soporte de OCR. Nunca se vincula contigo — sin cuenta, sin dirección IP, sin identificadores — y el contenido idéntico se almacena una sola vez sin importar cuántas personas lo vean.",
  "onboarding.help.contribute": "Contribuir con datos de subtítulos",
  "onboarding.help.decline": "No, gracias",
  "onboarding.help.thanks": "¡Gracias! Estás contribuyendo con datos de subtítulos.",
  "onboarding.help.noProblem": "Sin problema — no se compartirá nada.",
  "onboarding.help.changeLater":
    "Puedes cambiar esto en cualquier momento en el panel de ajustes ⚙ de la pastilla de Loom.",
  "onboarding.privacyPolicy": "Política de privacidad",
  "onboarding.helpFaq": "Ayuda y preguntas frecuentes",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Ajustes de Loom",
  "pill.discovering": "buscando…",
  "pill.noCaptions": "sin subtítulos",
  "pill.noSupportedTracks": "sin pistas compatibles",
  "pill.error": "error (ver consola)",
  "dormant.activate": "Activar Loom en esta pestaña",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "¿Quieres ayudar a mejorar Loom?",
  "consent.body":
    "Contribuye con datos de subtítulos anónimos (ID de video + texto de subtítulos — nunca nada sobre ti) para mejorar las anotaciones y la romanización.",
  "consent.contribute": "Contribuir",
  "consent.decline": "No, gracias",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Definición de {word}",
  "define.looking": "Buscando…",
  "define.unreachable": "No se pudo acceder al diccionario.",
  "define.noEntry": "Sin entrada en el diccionario.",
  "define.breakdown": "Desglose",
  "define.glossLanguage": "Idioma del diccionario",
  "define.glossAuto": "Automático",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (predeterminado)",
  "preset.loominate.desc": "Los colores pastel predeterminados de Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Apoyar a Loom",
  "settings.title": "Ajustes de Loom",
  "settings.close": "Cerrar ajustes",
  "settings.feedback": "Enviar comentarios",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Idioma del usuario (base de selección automática)",
  "settings.userLang.hint":
    "La selección automática admite cualquier variante regional (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Idioma del video (Arriba) — {count} pistas",
  "settings.bottomLang.title": "Idioma del usuario (Abajo)",
  "settings.bottomLang.autoTranslate":
    "(auto: traducir a {lang} cuando no hay pista coincidente)",
  "settings.bottomLang.noAutoTranslate":
    "(ninguna — sin traducción automática en {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Posición",
  "settings.videoLang": "Idioma del video",
  "settings.userLang": "Idioma del usuario",
  "settings.position.hint":
    "Ranura 1 = línea superior en su zona, ranura 2 = inferior. Una línea sola en una zona usa la posición predeterminada de la zona.",
  "settings.position.topNudge": "Línea superior — ajuste vertical",
  "settings.position.bottomNudge": "Línea inferior — ajuste vertical",
  "settings.position.lineSpacing": "Espaciado entre líneas",
  "settings.position.nudgeHint":
    "El ajuste mueve una línea hacia el centro de la imagen a medida que la subes (hacia abajo la línea superior, hacia arriba la inferior) — útil para separar el texto de las barras negras en videos con formato letterbox. Los carteles y las señales verticales mantienen su propia posición. Se guarda por plataforma.",
  "settings.pos.top1": "↑ Arriba 1",
  "settings.pos.top2": "↑ Arriba 2",
  "settings.pos.bot1": "↓ Abajo 1",
  "settings.pos.bot2": "↓ Abajo 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Tamaño de los subtítulos",
  "settings.size.overall": "Tamaño general",
  "settings.size.hint":
    "Escala todas las líneas juntas, además de los tamaños por línea de abajo. 100 % coincide con el valor predeterminado ajustado; redúcelo si los subtítulos se ven grandes aquí (p. ej. Netflix en pantalla completa). Se recuerda por separado para cada plataforma.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Ajustes de color predefinidos",
  "settings.preset.label": "Preajuste",
  "settings.preset.custom": "(personalizado)",
  "settings.preset.noPreset": "(sin preajuste — colores personalizados)",
  "settings.preset.loading": "Cargando preajustes…",
  "settings.preset.none":
    "No hay preajustes disponibles — cambia a una pista de chino, japonés, coreano, tailandés o ruso para ver preajustes temáticos por idioma, o usa Classic en cualquier pista.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Abajo — idioma del usuario",
  "settings.layer.showBottom": "Mostrar línea inferior",
  "settings.layer.top": "Arriba — idioma del video",
  "settings.layer.showTop": "Mostrar línea superior",
  "settings.layer.linkOpacity":
    "Vincular opacidad (anotación, romanización, ortografía alternativa)",
  "settings.layer.linkOpacityAria": "Vincular la opacidad del grupo superior",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Anotación por carácter",
  "settings.annotation.userLangAdvanced": "Anotación del idioma del usuario",
  "settings.annotation.hint":
    "Pequeñas lecturas encima de cada carácter — furigana para el japonés, Pinyin / Zhuyin / Jyutping para el chino, romanización para el coreano. Disponible para chino, japonés y coreano. El tamaño es una fracción de la línea Arriba (0,5 = la mitad).",
  "settings.annotate.none": "Todavía no hay anotación por carácter para este idioma.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Romanización (línea fonética)",
  "settings.romanization.userLangAdvanced": "Romanización del idioma del usuario",
  "settings.romanization.hint":
    "Una línea de pronunciación completa encima del texto del video. Disponible para chino, japonés, coreano y escrituras cirílica, tailandesa, índica, hebrea y árabe / persa / urdu. El selector de estilo aparece solo cuando hay más de una opción. El tamaño es una fracción de la línea principal.",
  "settings.romanize.style": "Estilo de romanización",
  "settings.romanize.auto": "Auto (predeterminado del idioma)",
  "settings.romanize.none":
    "No hay línea de pronunciación para este idioma (escritura latina o no compatible).",
  "settings.chooseTrack": "(elige primero una pista arriba)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Vocales largas del japonés",
  "settings.longVowel.macrons": "Macrones (tōkyō)",
  "settings.longVowel.doubled": "Vocales dobles (tookyoo)",
  "settings.longVowel.unmarked": "Sin marcar (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Datos",
  "settings.data.contribute": "Contribuir con datos de subtítulos",
  "settings.data.hint":
    "Envía los subtítulos de los videos que ves (título/ID del video y texto de los subtítulos — nunca nada sobre ti) al corpus de entrenamiento de Loom para mejorar las anotaciones, la romanización y el futuro soporte de OCR.",
  "settings.turnOff": "Desactivar Loom en esta pestaña",
  "settings.turnOff.hint":
    "Reactívalo con la pequeña pastilla que reaparece cuando lo desactivas. Persiste entre recargas de esta pestaña.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Los subtítulos de este título son imágenes, no texto, así que Loom no puede leerlos. Prueba con un título que tenga subtítulos basados en texto.",
  "settings.empty.noTracks": "No hay pistas de subtítulos compatibles en este video.",
  "settings.empty.discovering": "Buscando subtítulos…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Traducir a",
  "settings.noTranslation": "(sin traducción)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "manual",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Color",
  "settings.font": "Fuente",
  "settings.sizePx": "Tamaño (px)",
  "settings.sizeRatio": "Tamaño (proporción de Arriba)",
  "settings.opacity": "Opacidad",
  "settings.advanced": "Avanzado",
  "settings.outlineColor": "Color del contorno",
  "settings.outlineAlpha": "Alfa del contorno",
  "settings.glowRadius": "Radio del brillo (px)",
  "settings.glowNone": "0 = sin brillo",
  "settings.glowHalo": "Halo de {n}px",
  "settings.glowColor": "Color del brillo",
  "settings.glowAlpha": "Alfa del brillo",
  "settings.colorWheel": "Abrir la rueda de colores",
  "settings.setColor": "Fijar el color en {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + respaldo del sistema)",
  "settings.font.systemSans": "Sans-serif del sistema",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "sin romanización",
  "settings.proc.latinNone": "Latina (sin romanización)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Ortografía alternativa",
  "settings.variant.highlightColors": "Resaltado y colores",
  "settings.variant.colorCode": "Codificar por color los caracteres distintos",
  "settings.variant.simpSameAsTop": "Carácter simplificado: igual que Arriba",
  "settings.variant.simpColor": "Color del carácter simplificado",
  "settings.variant.matchesTop": "coincide con Arriba",
  "settings.variant.distinctColor": "Color del carácter distinto",
  "settings.variant.mergedColor": "Color del carácter fusionado",
  "settings.variant.preview": "Vista previa",
  "settings.variant.distinct": "Distinto",
  "settings.variant.merged": "Fusionado",
  "settings.variant.distinctHint":
    "el carácter tradicional tiene su propia forma simplificada, única (語 → 语). Alguien que lea el simplificado podría saber qué tradicional se pretendía.",
  "settings.variant.mergedHint":
    "varios caracteres tradicionales comparten la misma forma simplificada (髮 y 發 ambos → 发). El original se pierde — ahí es donde la simplificación descarta información.",
  "settings.variant.none":
    "No hay variante de ortografía en esta versión. Por ahora solo se admite el chino tradicional (zh-Hant / zh-TW / zh-HK / zh-MO / yue).",
};
