// Map a caption track's BCP-47 language code to the /define endpoint's
// two-value `lang` ("ja" | "zh").  The dictionary lookup only covers
// Japanese and Chinese (all Chinese variants share CC-CEDICT); every other
// language returns null (no per-word lookup — matches the backend, which
// only emits word `tokens` for ja/zh).

export type DefineLang = "ja" | "zh";

/** Chinese primary subtags that resolve to the shared CC-CEDICT lookup. */
const ZH_PRIMARIES = new Set(["zh", "yue", "wuu", "hak", "nan", "gan", "hsn"]);

export function defineLangFor(
  langCode: string | null | undefined,
): DefineLang | null {
  if (!langCode) return null;
  const primary = langCode.toLowerCase().split(/[-_]/)[0];
  if (primary === "ja") return "ja";
  if (ZH_PRIMARIES.has(primary)) return "zh";
  return null;
}
