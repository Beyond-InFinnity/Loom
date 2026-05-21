import { useCallback, useState } from "react";

import { CaptionOverlay } from "./caption-overlay";
import { CaptionStreamProvider } from "./caption-context";
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
  const [active, setActiveState] = useState<boolean>(readInitialActivated);

  const activate = useCallback(() => {
    setActiveState(true);
    writeActivated(true);
  }, []);

  const deactivate = useCallback(() => {
    setActiveState(false);
    writeActivated(false);
  }, []);

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
    </CaptionStreamProvider>
  );
}
