// Transient on-screen display — a brief centered message for volume / seek /
// speed / pause feedback, the way every media player flashes state changes.

import { useCallback, useRef, useState } from "react";

const OSD_MS = 1000;

export function useOsd(): [string | null, (msg: string) => void] {
  const [osd, setOsd] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback((msg: string) => {
    setOsd(msg);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOsd(null), OSD_MS);
  }, []);

  return [osd, show];
}
