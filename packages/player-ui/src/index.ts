// @loom/player-ui — the host-agnostic Loom caption UI (MOBILE_ROADMAP.md).
//
// Consumers today: the browser extension (via thin re-export shims at its
// old module paths, 7a).  Next: the Loom Player desktop/Android WebViews.
//
// This barrel exports the seam interfaces + the most-shared pure modules;
// deeper modules are importable by subpath (`@loom/player-ui/annotate/types`,
// `@loom/player-ui/components/annotated-text`, …).

export * from "./seams";
export { setUiLocaleProvider, resolveUiLocale, SUPPORTED_UI_LOCALES } from "./i18n/resolve";
export type { UiLocale } from "./i18n/resolve";
export { initUiLocale, getUiLocale, t, languageName } from "./i18n";
export type { StringKey, LocaleTable } from "./i18n";
