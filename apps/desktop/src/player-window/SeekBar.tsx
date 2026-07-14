// The Loom Player seek bar — the signature control.  A thin idle track that
// thickens on hover, an accent played-fill with a soft glow, a thumb that
// grows on grab, and a time bubble that tracks the cursor.  Pointer-driven
// (not a native range) so the bubble + hover-thicken feel right.

import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

interface SeekBarProps {
  valueMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
  formatTime: (ms: number) => string;
}

export function SeekBar({ valueMs, durationMs, onSeek, formatTime }: SeekBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  // While dragging (and briefly after), show the dragged value so the ~4 Hz
  // time-pos updates don't snap the fill back mid-scrub.
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const clearTimer = useRef<number | null>(null);

  const dur = Math.max(1, durationMs);
  const shown = dragMs ?? Math.min(valueMs, dur);
  const pct = Math.max(0, Math.min(100, (shown / dur) * 100));

  const msAt = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(dur, f * dur));
    },
    [dur],
  );

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      setDrag(true);
      const ms = msAt(e.clientX);
      setDragMs(ms);
      onSeek(ms);
    },
    [msAt, onSeek],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
        setHover({ x, ms: msAt(e.clientX) });
      }
      if (drag) {
        const ms = msAt(e.clientX);
        setDragMs(ms);
        onSeek(ms);
      }
    },
    [drag, msAt, onSeek],
  );

  const endDrag = useCallback(() => {
    setDrag(false);
    if (clearTimer.current) window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => setDragMs(null), 350);
  }, []);

  return (
    <div
      ref={ref}
      className={drag ? "lp-seek drag" : "lp-seek"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onPointerLeave={() => setHover(null)}
      title="Seek"
    >
      <div className="lp-track">
        <div className="lp-played" style={{ width: `${pct}%` }} />
        <div className="lp-thumb" style={{ left: `${pct}%` }} />
      </div>
      {hover && (
        <div className="lp-bubble" style={{ left: hover.x }}>
          {formatTime(hover.ms)}
        </div>
      )}
    </div>
  );
}
