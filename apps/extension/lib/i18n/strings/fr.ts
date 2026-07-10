import type { LocaleTable } from "./en";

// French (Français) UI strings. Keys and {param} placeholders match en.ts.
export const fr: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Double sous-titres pour les vidéos en langue étrangère.",
  "popup.enableLabel": "Loom sur ce navigateur",
  "popup.turnOff": "Désactiver Loom",
  "popup.turnOn": "Activer Loom",
  "popup.statusOn": "ACTIVÉ — Loom apparaît automatiquement sur les vidéos compatibles.",
  "popup.statusOff": "DÉSACTIVÉ — Loom ne s'exécute nulle part jusqu'à sa réactivation.",
  "popup.checkApi": "Vérifier l'API",
  "popup.checking": "Vérification…",
  "popup.apiHost": "API : {host}",
  "popup.httpStatus": "HTTP {status} : {body}",
  "popup.error": "Erreur : {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Apprends les langues avec les séries que tu regardes déjà.",
  "onboarding.step1.title": "Ouvrir une vidéo",
  "onboarding.step1.body":
    "Loom fonctionne sur {platforms} — toute vidéo sous-titrée dans la langue que tu apprends.",
  "onboarding.step2.title": "Cliquer sur la pastille Loom",
  "onboarding.step2.body":
    "Une petite pastille {pill} apparaît dans le lecteur. Cliquer dessus pour l'activer — chaque onglet reste inactif tant que tu ne le demandes pas.",
  "onboarding.step3.title": "Lire les quatre niveaux",
  "onboarding.step3.body":
    "Ta langue, la langue de la vidéo, une ligne phonétique et les lectures caractère par caractère (furigana, Pinyin, et plus encore). Le panneau ⚙ sur la pastille personnalise tout.",
  "onboarding.help.title": "Aider à améliorer Loom ?",
  "onboarding.help.body":
    "Contribue des données de sous-titres anonymes : les vidéos que tu regardes partagent leur identifiant vidéo et le texte des sous-titres avec le corpus d'entraînement de Loom, afin d'améliorer les annotations, la romanisation et le futur support OCR. Ce n'est jamais lié à toi — aucun compte, aucune adresse IP, aucun identifiant — et un contenu identique n'est stocké qu'une seule fois, peu importe le nombre de personnes qui le regardent.",
  "onboarding.help.contribute": "Contribuer des données de sous-titres",
  "onboarding.help.decline": "Non merci",
  "onboarding.help.thanks": "Merci ! Tu contribues des données de sous-titres.",
  "onboarding.help.noProblem": "Pas de problème — rien ne sera partagé.",
  "onboarding.help.changeLater":
    "Tu peux changer ce choix à tout moment dans le panneau de réglages ⚙ de la pastille Loom.",
  "onboarding.privacyPolicy": "Politique de confidentialité",
  "onboarding.helpFaq": "Aide et FAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Réglages Loom",
  "pill.discovering": "recherche…",
  "pill.noCaptions": "aucun sous-titre",
  "pill.noSupportedTracks": "aucune piste prise en charge",
  "pill.error": "erreur (voir la console)",
  "dormant.activate": "Activer Loom sur cet onglet",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Aider à améliorer Loom ?",
  "consent.body":
    "Contribue des données de sous-titres anonymes (identifiant vidéo + texte des sous-titres — jamais rien te concernant) pour améliorer les annotations et la romanisation.",
  "consent.contribute": "Contribuer",
  "consent.decline": "Non merci",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Définition de {word}",
  "define.looking": "Recherche…",
  "define.unreachable": "Impossible d'accéder au dictionnaire.",
  "define.noEntry": "Aucune entrée de dictionnaire.",
  "define.breakdown": "Décomposition",
  "define.grammar": "Grammaire",
  "define.glossLanguage": "Langue du dictionnaire",
  "define.glossAuto": "Automatique",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (par défaut)",
  "preset.loominate.desc": "Couleurs pastel par défaut de Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Soutenir Loom",
  "settings.title": "Réglages Loom",
  "settings.close": "Fermer les réglages",
  "settings.feedback": "Envoyer un commentaire",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Langue de l'utilisateur (base d'auto-sélection)",
  "settings.userLang.hint":
    "L'auto-sélection accepte toute variante régionale (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Langue de la vidéo (haut) — {count} pistes",
  "settings.bottomLang.title": "Langue de l'utilisateur (bas)",
  "settings.bottomLang.autoTranslate":
    "(auto : traduire en {lang} en l'absence de piste correspondante)",
  "settings.bottomLang.noAutoTranslate":
    "(aucune — pas de traduction automatique sur {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Position",
  "settings.videoLang": "Langue de la vidéo",
  "settings.userLang": "Langue de l'utilisateur",
  "settings.position.hint":
    "Emplacement 1 = ligne supérieure de sa zone, emplacement 2 = inférieure. Seule dans une zone, elle utilise la position par défaut de la zone.",
  "settings.position.topNudge": "Ligne du haut — décalage vertical",
  "settings.position.bottomNudge": "Ligne du bas — décalage vertical",
  "settings.position.lineSpacing": "Interligne",
  "settings.position.nudgeHint":
    "Le décalage rapproche une ligne du centre de l'image à mesure que tu la relèves (vers le bas pour la ligne du haut, vers le haut pour celle du bas) — pratique pour sortir le texte des bandes noires des vidéos au format letterbox. Les panneaux et les sous-titres verticaux conservent leur propre position. Enregistré par plateforme.",
  "settings.pos.top1": "↑ Haut 1",
  "settings.pos.top2": "↑ Haut 2",
  "settings.pos.bot1": "↓ Bas 1",
  "settings.pos.bot2": "↓ Bas 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Taille des sous-titres",
  "settings.size.overall": "Taille globale",
  "settings.size.hint":
    "Met à l'échelle toutes les lignes ensemble, en plus des tailles par ligne ci-dessous. 100 % correspond au réglage par défaut ; réduis-la si les sous-titres s'affichent trop grands ici (par ex. Netflix en plein écran). Mémorisé séparément pour chaque plateforme.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Palettes de couleurs",
  "settings.preset.label": "Palette",
  "settings.preset.custom": "(personnalisée)",
  "settings.preset.noPreset": "(aucune palette — couleurs personnalisées)",
  "settings.preset.loading": "Chargement des palettes…",
  "settings.preset.none":
    "Aucune palette disponible — passe à une piste en chinois, japonais, coréen, thaï ou russe pour voir les palettes thématiques, ou utilise Classic sur n'importe quelle piste.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Bas — langue de l'utilisateur",
  "settings.layer.showBottom": "Afficher la ligne du bas",
  "settings.layer.top": "Haut — langue de la vidéo",
  "settings.layer.showTop": "Afficher la ligne du haut",
  "settings.layer.linkOpacity":
    "Lier l'opacité (annotation, romanisation, orthographe alternative)",
  "settings.layer.linkOpacityAria": "Lier l'opacité du groupe du haut",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Annotation caractère par caractère",
  "settings.annotation.userLangAdvanced": "Annotation de la langue de l'utilisateur",
  "settings.annotation.hint":
    "Petites lectures au-dessus de chaque caractère — furigana pour le japonais, Pinyin / Zhuyin / Jyutping pour le chinois, romanisation pour le coréen. Disponible pour le chinois, le japonais et le coréen. La taille est une fraction de la ligne du haut (0,5 = moitié).",
  "settings.annotate.none": "Pas encore d'annotation caractère par caractère pour cette langue.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Romanisation (ligne phonétique)",
  "settings.romanization.userLangAdvanced": "Romanisation de la langue de l'utilisateur",
  "settings.romanization.hint":
    "Une ligne de prononciation complète au-dessus du texte de la vidéo. Disponible pour les écritures chinoise, japonaise, coréenne, cyrillique, thaïe, indiennes, hébraïque et arabe / persane / ourdoue. Le sélecteur de style n'apparaît que lorsqu'il y a plus d'une option. La taille est une fraction de la ligne parente.",
  "settings.romanize.style": "Style de romanisation",
  "settings.romanize.auto": "Auto (par défaut pour la langue)",
  "settings.romanize.none":
    "Pas de ligne de prononciation pour cette langue (écriture latine ou non prise en charge).",
  "settings.chooseTrack": "(choisis d'abord une piste ci-dessus)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Voyelles longues japonaises",
  "settings.longVowel.macrons": "Macrons (tōkyō)",
  "settings.longVowel.doubled": "Voyelles doublées (tookyoo)",
  "settings.longVowel.unmarked": "Non marquées (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Données",
  "settings.data.contribute": "Contribuer des données de sous-titres",
  "settings.data.hint":
    "Envoie les sous-titres des vidéos que tu regardes (titre/identifiant de la vidéo et texte des sous-titres — jamais rien te concernant) au corpus d'entraînement de Loom pour améliorer les annotations, la romanisation et le futur support OCR.",
  "settings.turnOff": "Désactiver Loom sur cet onglet",
  "settings.turnOff.hint":
    "Réactive-le via la petite pastille qui réapparaît lorsque tu le désactives. Persiste après les rechargements de cet onglet.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Les sous-titres de ce titre sont des images, pas du texte, donc Loom ne peut pas les lire. Essaie un titre avec des sous-titres textuels.",
  "settings.empty.noTracks": "Aucune piste de sous-titres prise en charge sur cette vidéo.",
  "settings.empty.discovering": "Recherche des sous-titres…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Traduire en",
  "settings.noTranslation": "(pas de traduction)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "manuelle",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Couleur",
  "settings.font": "Police",
  "settings.sizePx": "Taille (px)",
  "settings.sizeRatio": "Taille (ratio du haut)",
  "settings.opacity": "Opacité",
  "settings.advanced": "Avancé",
  "settings.outlineColor": "Couleur du contour",
  "settings.outlineAlpha": "Alpha du contour",
  "settings.glowRadius": "Rayon de la lueur (px)",
  "settings.glowNone": "0 = aucune lueur",
  "settings.glowHalo": "halo de {n} px",
  "settings.glowColor": "Couleur de la lueur",
  "settings.glowAlpha": "Alpha de la lueur",
  "settings.colorWheel": "Ouvrir la roue chromatique",
  "settings.setColor": "Régler la couleur sur {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + repli système)",
  "settings.font.systemSans": "Sans-serif système",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "pas de romanisation",
  "settings.proc.latinNone": "latin (pas de romanisation)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Orthographe alternative",
  "settings.variant.highlightColors": "Surbrillance et couleurs",
  "settings.variant.colorCode": "Coloriser les caractères différents",
  "settings.variant.simpSameAsTop": "Caractère simplifié : identique au haut",
  "settings.variant.simpColor": "Couleur du caractère simplifié",
  "settings.variant.matchesTop": "identique au haut",
  "settings.variant.distinctColor": "Couleur des caractères distincts",
  "settings.variant.mergedColor": "Couleur des caractères fusionnés",
  "settings.variant.preview": "Aperçu",
  "settings.variant.distinct": "Distinct",
  "settings.variant.merged": "Fusionné",
  "settings.variant.distinctHint":
    "le caractère traditionnel a sa propre forme simplifiée, unique (語 → 语). Quelqu'un lisant le simplifié pourrait deviner quel traditionnel était visé.",
  "settings.variant.mergedHint":
    "plusieurs caractères traditionnels partagent la même forme simplifiée (髮 et 發 → 发 tous les deux). L'original est perdu — c'est là que la simplification supprime de l'information.",
  "settings.variant.none":
    "Aucune variante orthographique dans cette version. Actuellement, seul le chinois traditionnel (zh-Hant / zh-TW / zh-HK / zh-MO / yue) est pris en charge.",
};
