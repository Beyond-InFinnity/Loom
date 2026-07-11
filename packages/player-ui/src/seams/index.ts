// The player-ui seam interfaces (MOBILE_ROADMAP.md §3) — everything a host
// must provide for the Loom caption UI to run in its WebView/shadow root.
//
// Seam #6 (LocaleProvider) is not a type here: it's `setUiLocaleProvider()`
// in ../i18n/resolve.ts (the host registers how to read the UI language).
// Seam #7 (MountAdapter) is host-side by definition — the host owns mounting
// <LoomApp/> (shadow root + compositor-layer style in the extension; plain
// document in a WebView) and never appears in this package.

export type { StorageAdapter, StorageChange, StorageValue } from "./storage";
export type { PlayerAdapter, PlayheadSource, ScaleSource } from "./player";
export type { CaptionTrackSource } from "./tracks";
export type { ApiConfig } from "./api";
