// Moved to @loom/player-ui (7a, MOBILE_ROADMAP.md) — re-export shim.
//
// This module is ALSO where the extension wires the LocaleProvider seam:
// every UI entrypoint imports `t`/`initUiLocale` from here, so registering
// the browser locale source at module load guarantees it precedes the
// entrypoint's initUiLocale() call.  The try/catch preserves the old
// guarded-fallback behavior in contexts without the API (tests, MAIN world).
import { setUiLocaleProvider } from "@loom/player-ui/i18n/resolve";

setUiLocaleProvider(() => {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return null;
  }
});

export * from "@loom/player-ui/i18n";
