// Auto-hiding player chrome: controls (and the cursor) show on any input and
// fade after a short idle while PLAYING.  They stay put whenever `keepVisible`
// is true — paused, a menu open, the pointer over the controls — so the user is
// never chasing a control that vanished mid-reach.

import { useCallback, useEffect, useRef, useState } from "react";

const HIDE_MS = 2600;

export interface AutoHide {
  visible: boolean;
  /** Force-show + restart the idle timer (e.g. after a keyboard volume nudge). */
  poke: () => void;
}

export function useAutoHideControls(keepVisible: boolean): AutoHide {
  const [visible, setVisible] = useState(true);
  const timer = useRef<number | null>(null);
  const keepRef = useRef(keepVisible);
  keepRef.current = keepVisible;

  const poke = useCallback(() => {
    setVisible(true);
    if (timer.current) window.clearTimeout(timer.current);
    if (!keepRef.current) {
      timer.current = window.setTimeout(() => setVisible(false), HIDE_MS);
    }
  }, []);

  // Any pointer/keyboard activity reveals the chrome.  Bound once — poke reads
  // the latest keepVisible via the ref, so it never goes stale.
  useEffect(() => {
    window.addEventListener("mousemove", poke);
    window.addEventListener("mousedown", poke);
    window.addEventListener("keydown", poke);
    window.addEventListener("wheel", poke);
    return () => {
      window.removeEventListener("mousemove", poke);
      window.removeEventListener("mousedown", poke);
      window.removeEventListener("keydown", poke);
      window.removeEventListener("wheel", poke);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [poke]);

  // keepVisible → on: pin visible + cancel the countdown.  off (resume): begin
  // the idle countdown from now.
  useEffect(() => {
    if (keepVisible) {
      setVisible(true);
      if (timer.current) window.clearTimeout(timer.current);
    } else {
      poke();
    }
  }, [keepVisible, poke]);

  return { visible, poke };
}
