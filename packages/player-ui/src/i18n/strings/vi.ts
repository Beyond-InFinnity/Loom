import type { LocaleTable } from "./en";

// Vietnamese (Tiếng Việt) UI strings. Keys and {param} placeholders match en.ts.
// Addresses the reader as "bạn"; the pill is "nút Loom" (the Loom button).
export const vi: LocaleTable = {
  // ── Popup ───────────────────────────────────────────────────────────────
  "popup.tagline": "Phụ đề kép cho video tiếng nước ngoài.",
  "popup.enableLabel": "Loom trên trình duyệt này",
  "popup.turnOff": "Tắt Loom",
  "popup.turnOn": "Bật Loom",
  "popup.statusOn": "BẬT — Loom tự động xuất hiện trên các video tương thích.",
  "popup.statusOff": "TẮT — Loom không chạy ở bất kỳ đâu cho đến khi bạn bật lại.",
  "popup.checkApi": "Kiểm tra API",
  "popup.checking": "Đang kiểm tra…",
  "popup.apiHost": "API: {host}",
  "popup.httpStatus": "HTTP {status}: {body}",
  "popup.error": "Lỗi: {message}",

  // ── Onboarding ──────────────────────────────────────────────────────────
  "onboarding.tagline": "Học ngoại ngữ từ chính những bộ phim bạn đang xem.",
  "onboarding.step1.title": "Mở một video",
  "onboarding.step1.body":
    "Loom hoạt động trên {platforms} — bất kỳ video nào có phụ đề bằng ngôn ngữ bạn đang học.",
  "onboarding.step2.title": "Nhấp vào nút Loom",
  "onboarding.step2.body":
    "Một nút nhỏ {pill} xuất hiện trong trình phát. Nhấp vào để kích hoạt — mỗi thẻ đều tắt cho đến khi bạn yêu cầu.",
  "onboarding.step3.title": "Đọc cả bốn lớp",
  "onboarding.step3.body":
    "Ngôn ngữ của bạn, ngôn ngữ của video, một dòng phiên âm và cách đọc từng ký tự (furigana, Pinyin và nhiều hơn nữa). Bảng ⚙ trên nút Loom cho phép tùy chỉnh mọi thứ.",
  "onboarding.help.title": "Giúp cải thiện Loom?",
  "onboarding.help.body":
    "Đóng góp dữ liệu phụ đề ẩn danh: các video bạn xem sẽ chia sẻ ID video và văn bản phụ đề với kho ngữ liệu huấn luyện của Loom để cải thiện chú thích, Latinh hóa và hỗ trợ OCR trong tương lai. Dữ liệu này không bao giờ được liên kết với bạn — không tài khoản, không địa chỉ IP, không mã định danh — và nội dung giống hệt nhau chỉ được lưu một lần, bất kể có bao nhiêu người xem.",
  "onboarding.help.contribute": "Đóng góp dữ liệu phụ đề",
  "onboarding.help.decline": "Không, cảm ơn",
  "onboarding.help.thanks": "Cảm ơn bạn! Bạn đang đóng góp dữ liệu phụ đề.",
  "onboarding.help.noProblem": "Không sao — sẽ không có gì được chia sẻ.",
  "onboarding.help.changeLater":
    "Bạn có thể thay đổi điều này bất cứ lúc nào trong bảng cài đặt ⚙ của nút Loom.",
  "onboarding.privacyPolicy": "Chính sách quyền riêng tư",
  "onboarding.helpFaq": "Trợ giúp & Câu hỏi thường gặp",

  // ── Pill / dormant ──────────────────────────────────────────────────────
  "pill.settings": "Cài đặt Loom",
  "pill.discovering": "đang tìm…",
  "pill.noCaptions": "không có phụ đề",
  "pill.noSupportedTracks": "không có bản phụ đề được hỗ trợ",
  "pill.error": "lỗi (xem console)",
  "dormant.activate": "Kích hoạt Loom trên thẻ này",

  // ── Corpus consent prompt ───────────────────────────────────────────────
  "consent.title": "Giúp cải thiện Loom?",
  "consent.body":
    "Đóng góp dữ liệu phụ đề ẩn danh (ID video + văn bản phụ đề — không bao giờ có thông tin về bạn) để cải thiện chú thích và Latinh hóa.",
  "consent.contribute": "Đóng góp",
  "consent.decline": "Không, cảm ơn",

  // ── Definition card ─────────────────────────────────────────────────────
  "define.of": "Định nghĩa của {word}",
  "define.looking": "Đang tra cứu…",
  "define.unreachable": "Không kết nối được với từ điển.",
  "define.noEntry": "Không có mục từ trong từ điển.",
  "define.breakdown": "Phân tích",
  "define.grammar": "Ngữ pháp",
  "define.glossLanguage": "Ngôn ngữ từ điển",
  "define.glossAuto": "Tự động",

  // ── Default preset (caption-context) ────────────────────────────────────
  "preset.loominate.label": "Loominate (Mặc định)",
  "preset.loominate.desc": "Bảng màu pastel mặc định của Loom.",

  // ── Settings panel: header / footer ─────────────────────────────────────
  "settings.support": "Ủng hộ Loom",
  "settings.title": "Cài đặt Loom",
  "settings.close": "Đóng cài đặt",
  "settings.feedback": "Gửi phản hồi",

  // ── Settings panel: language sections ───────────────────────────────────
  "settings.userLang.title": "Ngôn ngữ người dùng (cơ sở để tự chọn)",
  "settings.userLang.hint":
    "Tự chọn khớp với mọi biến thể theo vùng (en → en-US, en-GB, en-AU…).",
  "settings.videoLang.title": "Ngôn ngữ video (Trên) — {count} bản phụ đề",
  "settings.bottomLang.title": "Ngôn ngữ người dùng (Dưới)",
  "settings.bottomLang.autoTranslate":
    "(tự động: dịch sang {lang} khi không có bản phụ đề phù hợp)",
  "settings.bottomLang.noAutoTranslate":
    "(không có — {platform} không hỗ trợ dịch tự động)",

  // ── Settings panel: position ────────────────────────────────────────────
  "settings.position.title": "Vị trí",
  "settings.videoLang": "Ngôn ngữ video",
  "settings.userLang": "Ngôn ngữ người dùng",
  "settings.position.hint":
    "Ô 1 = dòng trên trong vùng của nó, ô 2 = dòng dưới. Một dòng đứng riêng trong vùng sẽ dùng vị trí mặc định của vùng đó.",
  "settings.position.topNudge": "Dòng trên — dịch chuyển dọc",
  "settings.position.bottomNudge": "Dòng dưới — dịch chuyển dọc",
  "settings.position.lineSpacing": "Giãn dòng",
  "settings.position.annotationSpacing": "Khoảng cách chú thích",
  "settings.position.nudgeHint":
    "Khi tăng giá trị, dòng sẽ dịch về phía giữa khung hình (xuống với dòng trên, lên với dòng dưới) — tiện để kéo chữ ra khỏi các dải đen trên video letterbox. Phụ đề biển hiệu và phụ đề dọc giữ nguyên vị trí riêng. Lưu riêng cho từng nền tảng.",
  "settings.pos.top1": "↑ Trên 1",
  "settings.pos.top2": "↑ Trên 2",
  "settings.pos.bot1": "↓ Dưới 1",
  "settings.pos.bot2": "↓ Dưới 2",

  // ── Settings panel: size ────────────────────────────────────────────────
  "settings.size.title": "Cỡ phụ đề",
  "settings.size.overall": "Cỡ tổng thể",
  "settings.size.hint":
    "Thay đổi tỉ lệ tất cả các dòng cùng lúc, cộng thêm vào cỡ của từng dòng bên dưới. 100% khớp với mặc định đã tinh chỉnh; hãy giảm xuống nếu phụ đề hiển thị quá lớn ở đây (ví dụ Netflix khi toàn màn hình). Được ghi nhớ riêng cho từng nền tảng.",

  // ── Settings panel: presets ─────────────────────────────────────────────
  "settings.presets.title": "Mẫu màu",
  "settings.preset.label": "Mẫu",
  "settings.preset.custom": "(tùy chỉnh)",
  "settings.preset.noPreset": "(không dùng mẫu — màu tùy chỉnh)",
  "settings.preset.loading": "Đang tải mẫu…",
  "settings.preset.none":
    "Không có mẫu nào — hãy chuyển sang bản phụ đề tiếng Trung, Nhật, Hàn, Thái hoặc Nga để xem các mẫu theo chủ đề ngôn ngữ, hoặc dùng Classic trên bất kỳ bản phụ đề nào.",

  // ── Settings panel: layer style blocks ──────────────────────────────────
  "settings.layer.bottom": "Dưới — ngôn ngữ người dùng",
  "settings.layer.showBottom": "Hiện dòng Dưới",
  "settings.layer.top": "Trên — ngôn ngữ video",
  "settings.layer.showTop": "Hiện dòng Trên",
  "settings.layer.linkOpacity":
    "Liên kết độ mờ đục (chú thích, Latinh hóa, cách viết thay thế)",
  "settings.layer.linkOpacityAria": "Liên kết độ mờ đục của nhóm Trên",

  // ── Settings panel: per-character annotation ────────────────────────────
  "settings.annotation.label": "Chú thích từng ký tự",
  "settings.annotation.userLangAdvanced": "Chú thích ngôn ngữ người dùng",
  "settings.annotation.hint":
    "Cách đọc nhỏ phía trên mỗi ký tự — furigana cho tiếng Nhật, Pinyin / Zhuyin / Jyutping cho tiếng Trung, Latinh hóa cho tiếng Hàn. Có cho tiếng Trung, tiếng Nhật và tiếng Hàn. Cỡ chữ là một phần của dòng Trên (0,5 = một nửa).",
  "settings.annotate.none": "Chưa có chú thích từng ký tự cho ngôn ngữ này.",

  // ── Settings panel: romanization line ───────────────────────────────────
  "settings.romanization.label": "Latinh hóa (dòng phiên âm)",
  "settings.romanization.userLangAdvanced": "Latinh hóa ngôn ngữ người dùng",
  "settings.romanization.hint":
    "Một dòng phát âm đầy đủ phía trên văn bản của video. Có cho tiếng Trung, tiếng Nhật, tiếng Hàn và các chữ viết Kirin, Thái, Ấn Độ, Do Thái và Ả Rập / Ba Tư / Urdu. Bộ chọn kiểu chỉ xuất hiện khi có nhiều hơn một lựa chọn. Cỡ chữ là một phần của dòng gốc.",
  "settings.romanize.style": "Kiểu Latinh hóa",
  "settings.romanize.auto": "Tự động (mặc định theo ngôn ngữ)",
  "settings.romanize.none":
    "Không có dòng phát âm cho ngôn ngữ này (chữ Latinh hoặc chưa được hỗ trợ).",
  "settings.chooseTrack": "(hãy chọn một bản phụ đề ở trên trước)",

  // ── Settings panel: Japanese long vowels ────────────────────────────────
  "settings.longVowel.label": "Nguyên âm dài tiếng Nhật",
  "settings.longVowel.macrons": "Dấu gạch trên (tōkyō)",
  "settings.longVowel.doubled": "Lặp nguyên âm (tookyoo)",
  "settings.longVowel.unmarked": "Không đánh dấu (tokyo)",

  // ── Settings panel: data / corpus ───────────────────────────────────────
  "settings.data.title": "Dữ liệu",
  "settings.data.contribute": "Đóng góp dữ liệu phụ đề",
  "settings.data.hint":
    "Gửi phụ đề của các video bạn xem (tiêu đề/ID video và văn bản phụ đề — không bao giờ có thông tin về bạn) đến kho ngữ liệu huấn luyện của Loom để cải thiện chú thích, Latinh hóa và hỗ trợ OCR trong tương lai.",
  "settings.turnOff": "Tắt Loom trên thẻ này",
  "settings.turnOff.hint":
    "Bật lại bằng nút nhỏ xuất hiện khi bạn tắt. Vẫn giữ nguyên khi tải lại thẻ này.",

  // ── Settings panel: empty states ────────────────────────────────────────
  "settings.empty.imageSubs":
    "Phụ đề của nội dung này là hình ảnh, không phải văn bản, nên Loom không đọc được. Hãy thử nội dung có phụ đề dạng văn bản.",
  "settings.empty.noTracks": "Video này không có bản phụ đề nào được hỗ trợ.",
  "settings.empty.discovering": "Đang tìm phụ đề…",

  // ── Settings panel: track list / translate ──────────────────────────────
  "settings.translateTo": "Dịch sang",
  "settings.noTranslation": "(không dịch)",
  "settings.track.auto": "(tự động)",
  "settings.badge.auto": "tự động",
  "settings.badge.asr": "asr",
  "settings.badge.manual": "thủ công",

  // ── Settings panel: per-layer style controls ────────────────────────────
  "settings.color": "Màu",
  "settings.font": "Phông chữ",
  "settings.sizePx": "Cỡ (px)",
  "settings.sizeRatio": "Cỡ (tỉ lệ so với Trên)",
  "settings.opacity": "Độ mờ đục",
  "settings.advanced": "Nâng cao",
  "settings.outlineColor": "Màu viền",
  "settings.outlineAlpha": "Alpha viền",
  "settings.glowRadius": "Bán kính phát sáng (px)",
  "settings.glowNone": "0 = không phát sáng",
  "settings.glowHalo": "Quầng sáng {n}px",
  "settings.glowColor": "Màu phát sáng",
  "settings.glowAlpha": "Alpha phát sáng",
  "settings.colorWheel": "Mở bánh xe màu",
  "settings.setColor": "Đặt màu thành {hex}",

  // ── Settings panel: font-family options (translatable ones only) ─────────
  "settings.font.auto": "Tự động (Noto + phông dự phòng của hệ thống)",
  "settings.font.systemSans": "Sans-serif hệ thống",

  // ── Settings panel: describeProcessing (translatable ones only) ─────────
  "settings.proc.none": "không Latinh hóa",
  "settings.proc.latinNone": "Latinh (không Latinh hóa)",

  // ── Settings panel: alternate orthography ───────────────────────────────
  "settings.variant.title": "Cách viết thay thế",
  "settings.variant.highlightColors": "Làm nổi bật & màu sắc",
  "settings.variant.colorCode": "Tô màu các ký tự khác nhau",
  "settings.variant.simpSameAsTop": "Ký tự giản thể: giống dòng Trên",
  "settings.variant.simpColor": "Màu ký tự giản thể",
  "settings.variant.matchesTop": "giống dòng Trên",
  "settings.variant.distinctColor": "Màu ký tự riêng biệt",
  "settings.variant.mergedColor": "Màu ký tự hợp nhất",
  "settings.variant.preview": "Xem trước",
  "settings.variant.distinct": "Riêng biệt",
  "settings.variant.merged": "Hợp nhất",
  "settings.variant.distinctHint":
    "ký tự phồn thể có dạng giản thể riêng của nó (語 → 语). Người đọc bản giản thể vẫn biết được ký tự phồn thể gốc là gì.",
  "settings.variant.mergedHint":
    "nhiều ký tự phồn thể dùng chung một dạng giản thể (髮 và 發 đều → 发). Ký tự gốc bị mất — đó là chỗ việc giản hóa làm mất thông tin.",
  "settings.variant.none":
    "bản dựng này không có biến thể chính tả. Hiện chỉ hỗ trợ tiếng Trung phồn thể (zh-Hant / zh-TW / zh-HK / zh-MO / yue).",
};
