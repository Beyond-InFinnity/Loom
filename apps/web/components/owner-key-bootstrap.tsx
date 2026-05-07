"use client";

// Picks up `?owner_key=<secret>` from the URL on first paint, stashes
// the value in localStorage, and rewrites the address bar without the
// param.  Subsequent API calls from this device send the key as
// X-Loom-Auth (see lib/api/client.ts) and the backend's bypass-aware
// slowapi wrapper skips rate limiting.
//
// Mounted once in app/layout.tsx so every page gets the bootstrap
// behavior + the floating "owner mode" indicator when active.  The
// indicator is the only visible signal that bypass is in effect — no
// other UI surface changes — so the operator knows when they're
// running unrestricted vs as a regular user.
//
// To clear: from devtools console run
//   localStorage.removeItem("loom_owner_key")
// or visit /?owner_key= (empty value) to overwrite.

import { useEffect, useState } from "react";

const STORAGE_KEY = "loom_owner_key";
const URL_PARAM = "owner_key";

export function OwnerKeyBootstrap() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const url = new URL(window.location.href);
      const param = url.searchParams.get(URL_PARAM);
      if (param !== null) {
        if (param.trim()) {
          window.localStorage.setItem(STORAGE_KEY, param.trim());
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
        }
        url.searchParams.delete(URL_PARAM);
        window.history.replaceState({}, "", url.toString());
      }
      setActive(!!window.localStorage.getItem(STORAGE_KEY));
    } catch {
      // localStorage may throw in private mode / sandboxed iframes —
      // silently degrade to "no bypass" rather than breaking the page.
      setActive(false);
    }
  }, []);

  if (!active) return null;
  return (
    <div
      className="fixed bottom-3 right-3 z-50 rounded-md border border-primary/40 bg-card/90 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-primary backdrop-blur-sm shadow-lg pointer-events-none"
      aria-label="Owner bypass active"
    >
      owner mode
    </div>
  );
}
