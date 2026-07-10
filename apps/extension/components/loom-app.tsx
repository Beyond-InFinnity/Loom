import { useCallback, useEffect, useState } from "react";

import { getEnabled, onEnabledChanged } from "@/lib/enabled";
import { initUiLocale } from "@/lib/i18n";
import { CaptionOverlay } from "./caption-overlay";
import { CaptionStreamProvider } from "./caption-context";
import { CorpusConsentPrompt } from "./corpus-consent-prompt";
import { DormantPill } from "./dormant-pill";
import { LoomPill } from "./loom-pill";

// LoomApp — root component for the in-page extension surface.
//
// Per-tab activation (5d-perf): each fresh YouTube tab/page-load
// starts dormant.  The dormant state mounts ONLY a small pill in
// the corner — no caption discovery, no caption stream, no overlay,
// no ResizeObservers, no /timedtext or /annotate fetches.  Click the
// pill to activate; the full pipeline mounts and Loom takes over.
//
// Persistence: sessionStorage (per-tab, per-origin).  Reloading the
// same tab keeps activation; opening a new tab starts dormant.  Clear
// the session (close tab) → next tab on the same URL starts dormant.
//
// Why per-tab and not per-extension: the user typically has many
// YouTube tabs open in the background.  Loom running on all of them
// burns CPU + memory unnecessarily.  Opt-in keeps idle tabs idle.

// Resolve the UI locale once, when the overlay module first loads in the page.
// All five content-script entrypoints render LoomApp, so this single call covers
// the whole in-page surface (pill, panel, consent, definition card).
initUiLocale();

const SESSION_STORAGE_KEY = "loom_activated";

function readInitialActivated(): boolean {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeActivated(active: boolean): void {
  try {
    if (active) sessionStorage.setItem(SESSION_STORAGE_KEY, "true");
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable (private browsing, quota exceeded) —
    // accept the loss; activation just won't persist across reloads.
  }
}

export function LoomApp() {
  // Global per-browser kill switch (lib/enabled.ts).  `null` = not yet
  // loaded from storage; render nothing until known so a disabled browser
  // never flashes the pill on page load.  Subscribed so toggling the popup
  // switch tears down (or brings up) the whole tree live, without a reload.
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [active, setActiveState] = useState<boolean>(readInitialActivated);

  useEffect(() => {
    let cancelled = false;
    getEnabled()
      .then((e) => {
        if (!cancelled) setEnabledState(e);
      })
      .catch(() => {
        // Fail open — a storage read error shouldn't silently disable Loom.
        if (!cancelled) setEnabledState(true);
      });
    const unsubscribe = onEnabledChanged((e) => setEnabledState(e));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const activate = useCallback(() => {
    setActiveState(true);
    writeActivated(true);
  }, []);

  const deactivate = useCallback(() => {
    setActiveState(false);
    writeActivated(false);
  }, []);

  // Kill switch off (or still loading) → render nothing at all.  When this
  // flips from true→false the active subtree below unmounts, firing every
  // cleanup useEffect (CaptionStream stop, ResizeObserver disconnect, MAIN
  // unsubscribe) — same teardown path as deactivate.
  if (enabled !== true) {
    return null;
  }

  if (!active) {
    return <DormantPill onActivate={activate} />;
  }

  // Active tree.  Unmounting this on deactivate fires all the cleanup
  // useEffects — CaptionStream stops, ResizeObserver disconnects,
  // discover.ts unsubscribes (subscriber count drops to 0, handleMessage
  // gates further MAIN tracklists).  Zero ongoing work after dormant.
  return (
    <CaptionStreamProvider>
      <CaptionOverlay />
      <LoomPill onDeactivate={deactivate} />
      {/* One-shot corpus-consent re-ask (renders null in dev builds and
          for anyone who has answered or been asked — see the component). */}
      <CorpusConsentPrompt />
    </CaptionStreamProvider>
  );
}
