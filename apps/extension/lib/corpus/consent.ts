// Corpus-contribution consent state (CORPUS_WIRING.md §1a/1d).
//
// Tri-state, stored in browser.storage.local like every other Loom pref:
//   - absent  (null)  → user has never answered.  Capture resolves to the
//                       build default: OFF in prod, ON in dev/owner builds
//                       (the operator's own watching anchors the corpus).
//   - true / false    → the user's explicit answer, from the onboarding
//                       page, the post-first-episode re-ask, or the
//                       settings-panel toggle.  Always wins over defaults.
//
// A separate `loom_corpus_asked` flag makes the in-overlay re-ask fire at
// most once ever: it's set the moment the re-ask is SHOWN (not answered),
// and also by any explicit answer, so a user who ignores or dismisses the
// prompt is never nagged again — the settings toggle remains the way in.
//
// Consent is written from OTHER extension contexts than the content script
// that reads it (the onboarding page, the popup-adjacent settings panel),
// so the module keeps a storage.onChanged-subscribed cache rather than a
// read-once module variable — same cross-context liveness pattern as
// lib/enabled.ts.
//
// Store-policy note (do not weaken): capture must NEVER default on in a
// production build. Chrome requires affirmative consent via a specific
// user action before collection; sources pinned in CORPUS_WIRING.md §1a.

import { IS_DEV } from "../env";
import { storage } from "../host";

export const STORAGE_KEY_CORPUS_OPT_IN = "loom_corpus_opt_in";
export const STORAGE_KEY_CORPUS_ASKED = "loom_corpus_asked";

/** null = never answered. */
export type CorpusConsent = boolean | null;

/** Pure resolution rule — unit-tested; `isDev` injected for testability. */
export function resolveCaptureEnabled(
  consent: CorpusConsent,
  isDev: boolean,
): boolean {
  return consent === null ? isDev : consent;
}

function coerceConsent(value: unknown): CorpusConsent {
  return typeof value === "boolean" ? value : null;
}

let consentCache: CorpusConsent | undefined;
let askedCache: boolean | undefined;
let watching = false;

function ensureWatcher(): void {
  if (watching) return;
  watching = true;
  storage.onChanged((changes) => {
    if (STORAGE_KEY_CORPUS_OPT_IN in changes) {
      consentCache = coerceConsent(changes[STORAGE_KEY_CORPUS_OPT_IN]?.newValue);
    }
    if (STORAGE_KEY_CORPUS_ASKED in changes) {
      askedCache = changes[STORAGE_KEY_CORPUS_ASKED]?.newValue === true;
    }
  });
}

export async function getCorpusConsent(): Promise<CorpusConsent> {
  ensureWatcher();
  if (consentCache === undefined) {
    const result = await storage.get(STORAGE_KEY_CORPUS_OPT_IN);
    consentCache = coerceConsent(result[STORAGE_KEY_CORPUS_OPT_IN]);
  }
  return consentCache;
}

/** An explicit answer also marks the question as asked. */
export async function setCorpusConsent(value: boolean): Promise<void> {
  ensureWatcher();
  consentCache = value;
  askedCache = true;
  await storage.set({
    [STORAGE_KEY_CORPUS_OPT_IN]: value,
    [STORAGE_KEY_CORPUS_ASKED]: true,
  });
}

export async function getCorpusAsked(): Promise<boolean> {
  ensureWatcher();
  if (askedCache === undefined) {
    const result = await storage.get(STORAGE_KEY_CORPUS_ASKED);
    askedCache = result[STORAGE_KEY_CORPUS_ASKED] === true;
  }
  return askedCache;
}

/** Called when the re-ask prompt is SHOWN, so it can never fire twice. */
export async function markCorpusAsked(): Promise<void> {
  ensureWatcher();
  askedCache = true;
  await storage.set({ [STORAGE_KEY_CORPUS_ASKED]: true });
}

/** The one question the capture path asks. */
export async function isCaptureEnabled(): Promise<boolean> {
  return resolveCaptureEnabled(await getCorpusConsent(), IS_DEV);
}

/** Test seam — clears the module caches AND the watcher flag (tests swap
    the browser stub per-case, so the onChanged listener must re-register;
    fake-browser storage resets between tests, but module state doesn't). */
export function _resetConsentStateForTests(): void {
  consentCache = undefined;
  askedCache = undefined;
  watching = false;
}
