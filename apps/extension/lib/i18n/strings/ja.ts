import type { LocaleTable } from "./en";

// Japanese (日本語) UI strings. Keys and {param} placeholders match en.ts.
export const ja: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "外国語動画に二重字幕を。",
  "popup.enableLabel": "このブラウザでLoomを有効化",
  "popup.turnOff": "Loomをオフにする",
  "popup.turnOn": "Loomをオンにする",
  "popup.statusOn": "オン — 対応動画で自動的にLoomが表示されます。",
  "popup.statusOff": "オフ — オンに戻すまでLoomはどこでも動作しません。",
  "popup.checkApi": "APIを確認",
  "popup.checking": "確認中…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "エラー: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "いつも観ている番組で語学学習を。",
  "onboarding.step1.title": "動画を開く",
  "onboarding.step1.body":
    "Loomは{platforms}に対応 — 学習中の言語の字幕がある動画ならどれでも使えます。",
  "onboarding.step2.title": "Loomのピルをクリック",
  "onboarding.step2.body":
    "プレーヤーに小さな{pill}ピルが表示されます。クリックして有効化 — 各タブは操作するまでオフのままです。",
  "onboarding.step3.title": "4つのレイヤーすべてを読む",
  "onboarding.step3.body":
    "あなたの言語、動画の言語、発音ライン、そして文字ごとの読み（ふりがな、Pinyinなど）。ピルの⚙パネルですべてをカスタマイズできます。",
  "onboarding.help.title": "Loomの改善に協力しませんか？",
  "onboarding.help.body":
    "匿名の字幕データを提供: 観た動画の動画IDと字幕テキストをLoomの学習用コーパスに共有し、アノテーション・ローマ字化・将来のOCR対応の改善に役立てます。あなたと結び付けられることはなく — アカウントもIPアドレスも識別子もありません — 同じ内容は何人が観ても一度だけ保存されます。",
  "onboarding.help.contribute": "字幕データを提供する",
  "onboarding.help.decline": "いいえ、結構です",
  "onboarding.help.thanks": "ありがとうございます！字幕データを提供いただいています。",
  "onboarding.help.noProblem": "問題ありません — 何も共有されません。",
  "onboarding.help.changeLater":
    "この設定はLoomピルの⚙設定パネルからいつでも変更できます。",
  "onboarding.privacyPolicy": "プライバシーポリシー",
  "onboarding.helpFaq": "ヘルプとFAQ",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Loom設定",
  "pill.discovering": "検出中…",
  "pill.noCaptions": "字幕なし",
  "pill.noSupportedTracks": "対応トラックなし",
  "pill.error": "エラー（コンソールを確認）",
  "dormant.activate": "このタブでLoomを有効化",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Loomの改善に協力しませんか？",
  "consent.body":
    "匿名の字幕データ（動画IDと字幕テキスト — あなた個人に関する情報は一切なし）を提供し、アノテーションとローマ字化の改善に役立てます。",
  "consent.contribute": "提供する",
  "consent.decline": "いいえ、結構です",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "{word}の意味",
  "define.looking": "検索中…",
  "define.unreachable": "辞書に接続できませんでした。",
  "define.noEntry": "辞書に項目がありません。",
  "define.breakdown": "内訳",
  "define.grammar": "文法",
  "define.glossLanguage": "辞書の言語",
  "define.glossAuto": "自動",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate（デフォルト）",
  "preset.loominate.desc": "Loomのデフォルトのパステルカラー。",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Loomを支援する",
  "settings.title": "Loom設定",
  "settings.close": "設定を閉じる",
  "settings.feedback": "フィードバックを送る",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "ユーザー言語（自動選択の基準）",
  "settings.userLang.hint":
    "自動選択は地域バリアントにも対応します（en → en-US、en-GB、en-AU…）。",
  "settings.videoLang.title": "動画の言語（Top） — {count}トラック",
  "settings.bottomLang.title": "ユーザー言語（Bottom）",
  "settings.bottomLang.autoTranslate":
    "（自動: 一致するトラックがない場合は{lang}に翻訳）",
  "settings.bottomLang.noAutoTranslate":
    "（なし — {platform}では自動翻訳は利用できません）",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "位置",
  "settings.videoLang": "動画の言語",
  "settings.userLang": "ユーザー言語",
  "settings.position.hint":
    "スロット1 = そのゾーンの上の行、スロット2 = 下の行。ゾーンに1行だけの場合はそのゾーンの既定位置になります。",
  "settings.position.topNudge": "Topの行 — 縦方向の微調整",
  "settings.position.bottomNudge": "Bottomの行 — 縦方向の微調整",
  "settings.position.lineSpacing": "行間",
  "settings.position.nudgeHint":
    "微調整は行を上げるほど映像の中央へ寄せます（Topの行は下へ、Bottomの行は上へ）— レターボックスの黒帯からテキストを引き離すのに便利です。標識や縦書きの字幕は独自の位置を保ちます。プラットフォームごとに保存されます。",
  "settings.pos.top1": "↑ Top 1",
  "settings.pos.top2": "↑ Top 2",
  "settings.pos.bot1": "↓ Bot 1",
  "settings.pos.bot2": "↓ Bot 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "字幕サイズ",
  "settings.size.overall": "全体サイズ",
  "settings.size.hint":
    "下の行ごとのサイズに加えて、すべての行をまとめて拡大縮小します。100%が調整済みの既定値です。ここで字幕が大きく表示される場合（例: 全画面のNetflix）は下げてください。プラットフォームごとに個別に記憶されます。",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "カラープリセット",
  "settings.preset.label": "プリセット",
  "settings.preset.custom": "（カスタム）",
  "settings.preset.noPreset": "（プリセットなし — カスタムカラー）",
  "settings.preset.loading": "プリセットを読み込み中…",
  "settings.preset.none":
    "利用できるプリセットがありません — 中国語・日本語・韓国語・タイ語・ロシア語のトラックに切り替えると言語テーマのプリセットが表示されます。どのトラックでもClassicは利用できます。",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Bottom — ユーザー言語",
  "settings.layer.showBottom": "Bottomの行を表示",
  "settings.layer.top": "Top — 動画の言語",
  "settings.layer.showTop": "Topの行を表示",
  "settings.layer.linkOpacity":
    "不透明度を連動（アノテーション、ローマ字化、別表記）",
  "settings.layer.linkOpacityAria": "Topグループの不透明度を連動",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "文字ごとのアノテーション",
  "settings.annotation.userLangAdvanced": "ユーザー言語のアノテーション",
  "settings.annotation.hint":
    "各文字の上に小さな読みを表示 — 日本語はふりがな、中国語はPinyin / Zhuyin / Jyutping、韓国語はローマ字化。中国語・日本語・韓国語で利用できます。サイズはTopの行に対する比率です（0.5 = 半分）。",
  "settings.annotate.none": "この言語ではまだ文字ごとのアノテーションはありません。",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "ローマ字化（発音ライン）",
  "settings.romanization.userLangAdvanced": "ユーザー言語のローマ字化",
  "settings.romanization.hint":
    "動画のテキストの上に発音のフルラインを表示します。中国語・日本語・韓国語・キリル文字・タイ語・インド系文字・ヘブライ語・アラビア語 / ペルシア語 / ウルドゥー語の文字に対応。スタイルの選択肢は複数ある場合にのみ表示されます。サイズは親の行に対する比率です。",
  "settings.romanize.style": "ローマ字化スタイル",
  "settings.romanize.auto": "自動（言語ごとの既定）",
  "settings.romanize.none":
    "この言語には発音ラインがありません（ラテン文字または非対応）。",
  "settings.chooseTrack": "（先に上でトラックを選択してください）",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "日本語の長音",
  "settings.longVowel.macrons": "マクロン（tōkyō）",
  "settings.longVowel.doubled": "母音を重ねる（tookyoo）",
  "settings.longVowel.unmarked": "表記なし（tokyo）",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "データ",
  "settings.data.contribute": "字幕データを提供する",
  "settings.data.hint":
    "観た動画の字幕（動画のタイトル/IDと字幕テキスト — あなた個人に関する情報は一切なし）をLoomの学習用コーパスに送信し、アノテーション・ローマ字化・将来のOCR対応の改善に役立てます。",
  "settings.turnOff": "このタブでLoomをオフにする",
  "settings.turnOff.hint":
    "オフにすると戻ってくる小さなピルから再び有効化できます。このタブのリロードをまたいで維持されます。",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "この作品の字幕はテキストではなく画像のため、Loomでは読み取れません。テキストベースの字幕がある作品をお試しください。",
  "settings.empty.noTracks": "この動画には対応する字幕トラックがありません。",
  "settings.empty.discovering": "字幕を検出中…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "翻訳先",
  "settings.noTranslation": "（翻訳なし）",
  "settings.track.auto": "（自動）",
  "settings.badge.auto": "自動",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "手動",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "色",
  "settings.font": "フォント",
  "settings.sizePx": "サイズ（px）",
  "settings.sizeRatio": "サイズ（Topに対する比率）",
  "settings.opacity": "不透明度",
  "settings.advanced": "詳細設定",
  "settings.outlineColor": "縁取りの色",
  "settings.outlineAlpha": "縁取りの不透明度",
  "settings.glowRadius": "グローの半径（px）",
  "settings.glowNone": "0 = グローなし",
  "settings.glowHalo": "{n}pxのハロー",
  "settings.glowColor": "グローの色",
  "settings.glowAlpha": "グローの不透明度",
  "settings.colorWheel": "カラーホイールを開く",
  "settings.setColor": "色を{hex}に設定",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "自動（Noto + システムのフォールバック）",
  "settings.font.systemSans": "システムのサンセリフ",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "ローマ字化なし",
  "settings.proc.latinNone": "ラテン文字（ローマ字化なし）",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "別の字体",
  "settings.variant.highlightColors": "ハイライトと色",
  "settings.variant.colorCode": "異なる文字を色分け",
  "settings.variant.simpSameAsTop": "簡体字: Topと同じ",
  "settings.variant.simpColor": "簡体字の色",
  "settings.variant.matchesTop": "Topと一致",
  "settings.variant.distinctColor": "Distinct文字の色",
  "settings.variant.mergedColor": "Merged文字の色",
  "settings.variant.preview": "プレビュー",
  "settings.variant.distinct": "Distinct",
  "settings.variant.merged": "Merged",
  "settings.variant.distinctHint":
    "その繁体字には固有の簡体字の形があります（語 → 语）。簡体字を読む人が、元がどの繁体字だったか判別できます。",
  "settings.variant.mergedHint":
    "複数の繁体字が同じ簡体字の形を共有します（髮と發はどちらも → 发）。元の字は失われ — 簡体化で情報が捨てられる箇所です。",
  "settings.variant.none":
    "このビルドには字体バリアントがありません。現在は繁体字中国語（zh-Hant / zh-TW / zh-HK / zh-MO / yue）のみ対応しています。",
};
