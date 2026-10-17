import type { LocaleTable } from "./en";

// Portuguese (Português) UI strings — Brazilian Portuguese, also served to pt-PT
// browsers (one table: "você", "vídeo", "tela"). Keys and {param} placeholders
// match en.ts.
export const pt: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Legendas duplas para vídeos em idiomas estrangeiros.",
  "popup.enableLabel": "Loom neste navegador",
  "popup.turnOff": "Desativar o Loom",
  "popup.turnOn": "Ativar o Loom",
  "popup.statusOn": "ATIVADO — o Loom aparece automaticamente nos vídeos compatíveis.",
  "popup.statusOff": "DESATIVADO — o Loom não funciona em lugar nenhum até você ativá-lo de novo.",
  "popup.checkApi": "Verificar API",
  "popup.checking": "Verificando…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Erro: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Aprenda idiomas com as séries que você já assiste.",
  "onboarding.step1.title": "Abra um vídeo",
  "onboarding.step1.body":
    "O Loom funciona com {platforms} — qualquer vídeo com legendas no idioma que você está aprendendo.",
  "onboarding.step2.title": "Clique na pílula do Loom",
  "onboarding.step2.body":
    "Uma pequena pílula {pill} aparece no player. Clique nela para ativar — cada aba fica desativada até você pedir.",
  "onboarding.step3.title": "Leia as quatro camadas",
  "onboarding.step3.body":
    "Seu idioma, o idioma do vídeo, uma linha fonética e as leituras por caractere (furigana, Pinyin e mais). O painel ⚙ da pílula personaliza tudo.",
  "onboarding.help.title": "Quer ajudar a melhorar o Loom?",
  "onboarding.help.body":
    "Contribua com dados de legendas anônimos: os vídeos que você assiste compartilham o ID do vídeo e o texto das legendas com o corpus de treinamento do Loom para melhorar as anotações, a romanização e o futuro suporte a OCR. Nada disso é vinculado a você — sem conta, sem endereço IP, sem identificadores — e conteúdo idêntico é armazenado uma única vez, não importa quantas pessoas o assistam.",
  "onboarding.help.contribute": "Contribuir com dados de legendas",
  "onboarding.help.decline": "Não, obrigado",
  "onboarding.help.thanks": "Obrigado! Você está contribuindo com dados de legendas.",
  "onboarding.help.noProblem": "Sem problemas — nada será compartilhado.",
  "onboarding.help.changeLater":
    "Você pode mudar isso a qualquer momento no painel de configurações ⚙ da pílula do Loom.",
  "onboarding.privacyPolicy": "Política de privacidade",
  "onboarding.helpFaq": "Ajuda e perguntas frequentes",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Configurações do Loom",
  "pill.discovering": "procurando…",
  "pill.noCaptions": "sem legendas",
  "pill.noSupportedTracks": "nenhuma faixa compatível",
  "pill.error": "erro (veja o console)",
  "dormant.activate": "Ativar o Loom nesta aba",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Quer ajudar a melhorar o Loom?",
  "consent.body":
    "Contribua com dados de legendas anônimos (ID do vídeo + texto das legendas — nunca nada sobre você) para melhorar as anotações e a romanização.",
  "consent.contribute": "Contribuir",
  "consent.decline": "Não, obrigado",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Definição de {word}",
  "define.looking": "Buscando…",
  "define.unreachable": "Não foi possível acessar o dicionário.",
  "define.noEntry": "Nenhuma entrada no dicionário.",
  "define.breakdown": "Análise",
  "define.grammar": "Gramática",
  "define.glossLanguage": "Idioma do dicionário",
  "define.glossAuto": "Automático",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (padrão)",
  "preset.loominate.desc": "As cores pastel padrão do Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Apoiar o Loom",
  "settings.title": "Configurações do Loom",
  "settings.close": "Fechar configurações",
  "settings.feedback": "Enviar feedback",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Idioma do usuário (base da seleção automática)",
  "settings.userLang.hint":
    "A seleção automática aceita qualquer variante regional (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Idioma do vídeo (Acima) — {count} faixas",
  "settings.bottomLang.title": "Idioma do usuário (Abaixo)",
  "settings.bottomLang.autoTranslate":
    "(auto: traduzir para {lang} quando não houver faixa correspondente)",
  "settings.bottomLang.noAutoTranslate":
    "(nenhuma — sem tradução automática em {platform})",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Posição",
  "settings.videoLang": "Idioma do vídeo",
  "settings.userLang": "Idioma do usuário",
  "settings.position.hint":
    "Posição 1 = linha de cima na sua zona, posição 2 = a de baixo. Uma linha sozinha na zona usa a posição padrão da zona.",
  "settings.position.topNudge": "Linha superior — ajuste vertical",
  "settings.position.bottomNudge": "Linha inferior — ajuste vertical",
  "settings.position.lineSpacing": "Espaçamento entre linhas",
  "settings.position.annotationSpacing": "Espaçamento da anotação",
  "settings.position.nudgeHint":
    "O ajuste move a linha em direção ao centro da imagem conforme você aumenta o valor (para baixo na linha superior, para cima na inferior) — útil para tirar o texto das faixas pretas em vídeos letterbox. Placas e legendas verticais mantêm a própria posição. Salvo por plataforma.",
  "settings.pos.top1": "↑ Acima 1",
  "settings.pos.top2": "↑ Acima 2",
  "settings.pos.bot1": "↓ Abaixo 1",
  "settings.pos.bot2": "↓ Abaixo 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Tamanho das legendas",
  "settings.size.overall": "Tamanho geral",
  "settings.size.hint":
    "Ajusta a escala de todas as linhas juntas, somando-se aos tamanhos por linha abaixo. 100% corresponde ao padrão ajustado; reduza se as legendas ficarem grandes aqui (por exemplo, Netflix em tela cheia). Lembrado separadamente para cada plataforma.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Predefinições de cores",
  "settings.preset.label": "Predefinição",
  "settings.preset.custom": "(personalizado)",
  "settings.preset.noPreset": "(sem predefinição — cores personalizadas)",
  "settings.preset.loading": "Carregando predefinições…",
  "settings.preset.none":
    "Nenhuma predefinição disponível — mude para uma faixa em chinês, japonês, coreano, tailandês ou russo para ver predefinições temáticas por idioma, ou use Classic em qualquer faixa.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Abaixo — idioma do usuário",
  "settings.layer.showBottom": "Mostrar linha inferior",
  "settings.layer.top": "Acima — idioma do vídeo",
  "settings.layer.showTop": "Mostrar linha superior",
  "settings.layer.linkOpacity":
    "Vincular opacidade (anotação, romanização, grafia alternativa)",
  "settings.layer.linkOpacityAria": "Vincular a opacidade do grupo superior",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Anotação por caractere",
  "settings.annotation.userLangAdvanced": "Anotação do idioma do usuário",
  "settings.annotation.hint":
    "Pequenas leituras acima de cada caractere — furigana para japonês, Pinyin / Zhuyin / Jyutping para chinês, romanização para coreano. Disponível para chinês, japonês e coreano. O tamanho é uma fração da linha Acima (0,5 = metade).",
  "settings.annotate.none": "Ainda não há anotação por caractere para este idioma.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Romanização (linha fonética)",
  "settings.romanization.userLangAdvanced": "Romanização do idioma do usuário",
  "settings.romanization.hint":
    "Uma linha completa de pronúncia acima do texto do vídeo. Disponível para chinês, japonês, coreano e as escritas cirílica, tailandesa, índica, hebraica e árabe / persa / urdu. O seletor de estilo só aparece quando há mais de uma opção. O tamanho é uma fração da linha principal.",
  "settings.romanize.style": "Estilo de romanização",
  "settings.romanize.auto": "Auto (padrão do idioma)",
  "settings.romanize.none":
    "Não há linha de pronúncia para este idioma (escrita latina ou não compatível).",
  "settings.chooseTrack": "(escolha uma faixa acima primeiro)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Vogais longas do japonês",
  "settings.longVowel.macrons": "Mácrons (tōkyō)",
  "settings.longVowel.doubled": "Vogais duplas (tookyoo)",
  "settings.longVowel.unmarked": "Sem marcação (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Dados",
  "settings.data.contribute": "Contribuir com dados de legendas",
  "settings.data.hint":
    "Envia as legendas dos vídeos que você assiste (título/ID do vídeo e texto das legendas — nunca nada sobre você) para o corpus de treinamento do Loom, para melhorar as anotações, a romanização e o futuro suporte a OCR.",
  "settings.turnOff": "Desativar o Loom nesta aba",
  "settings.turnOff.hint":
    "Reative pela pequena pílula que volta a aparecer quando você o desativa. Continua assim ao recarregar esta aba.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "As legendas deste título são imagens, não texto, então o Loom não consegue lê-las. Tente um título com legendas em texto.",
  "settings.empty.noTracks": "Nenhuma faixa de legendas compatível neste vídeo.",
  "settings.empty.discovering": "Procurando legendas…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Traduzir para",
  "settings.noTranslation": "(sem tradução)",
  "settings.track.auto": "(auto)",
  "settings.badge.auto": "auto",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "manual",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Cor",
  "settings.font": "Fonte",
  "settings.sizePx": "Tamanho (px)",
  "settings.sizeRatio": "Tamanho (proporção de Acima)",
  "settings.opacity": "Opacidade",
  "settings.advanced": "Avançado",
  "settings.outlineColor": "Cor do contorno",
  "settings.outlineAlpha": "Alfa do contorno",
  "settings.glowRadius": "Raio do brilho (px)",
  "settings.glowNone": "0 = sem brilho",
  "settings.glowHalo": "Halo de {n}px",
  "settings.glowColor": "Cor do brilho",
  "settings.glowAlpha": "Alfa do brilho",
  "settings.colorWheel": "Abrir a roda de cores",
  "settings.setColor": "Definir a cor como {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Auto (Noto + fonte reserva do sistema)",
  "settings.font.systemSans": "Sans-serif do sistema",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "sem romanização",
  "settings.proc.latinNone": "Latina (sem romanização)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Grafia alternativa",
  "settings.variant.highlightColors": "Destaque e cores",
  "settings.variant.colorCode": "Colorir os caracteres que diferem",
  "settings.variant.simpSameAsTop": "Caractere simplificado: igual a Acima",
  "settings.variant.simpColor": "Cor do caractere simplificado",
  "settings.variant.matchesTop": "igual a Acima",
  "settings.variant.distinctColor": "Cor do caractere distinto",
  "settings.variant.mergedColor": "Cor do caractere fundido",
  "settings.variant.preview": "Prévia",
  "settings.variant.distinct": "Distinto",
  "settings.variant.merged": "Fundido",
  "settings.variant.distinctHint":
    "o caractere tradicional tem a sua própria forma simplificada única (語 → 语). Quem lê o simplificado consegue saber qual tradicional era.",
  "settings.variant.mergedHint":
    "vários caracteres tradicionais compartilham a mesma forma simplificada (髮 e 發 → 发). O original se perde — é aí que a simplificação descarta informação.",
  "settings.variant.none":
    "nenhuma variante de grafia nesta versão. Por enquanto só o chinês tradicional (zh-Hant / zh-TW / zh-HK / zh-MO / yue) é compatível.",
};
