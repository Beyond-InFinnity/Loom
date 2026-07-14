// A custom dark dropdown for the control bar — replaces native <select> so the
// popup is fully themed (WebKitGTK renders the native option list OS-white,
// which broke the dark chrome).  Opens upward above the bar; a transparent
// full-screen backdrop closes it on outside-click WITHOUT the click falling
// through to the video (which would toggle pause).

import { useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  name: string;
  /** Trailing muted hint (e.g. a language code). */
  sub?: string;
}

interface PlayerSelectProps {
  /** Uppercase micro-label shown before the value (e.g. "Video"). */
  label?: string;
  value: string;
  /** Text shown in the closed pill; defaults to the current option's name. */
  display?: string;
  /** Menu header. */
  head?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  title: string;
  /** Which edge the menu aligns to (default right — pills sit right-of-center). */
  align?: "left" | "right";
  /** Fires true/false as the menu opens/closes, so the parent can pin the
      auto-hiding control bar open while a menu is up. */
  onOpenChange?: (open: boolean) => void;
}

export function PlayerSelect({
  label,
  value,
  display,
  head,
  options,
  onChange,
  title,
  align = "right",
  onOpenChange,
}: PlayerSelectProps) {
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);

  // Report open/close transitions exactly once (never on mount).
  useEffect(() => {
    if (open !== wasOpen.current) {
      wasOpen.current = open;
      onOpenChange?.(open);
    }
  }, [open, onOpenChange]);
  // If we unmount while open (e.g. the audio picker disappears on track
  // change), release the parent's pin.
  useEffect(
    () => () => {
      if (wasOpen.current) onOpenChange?.(false);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const current = options.find((o) => o.value === value);
  const shown = display ?? current?.name ?? value;

  return (
    <div className="lp-sel" style={{ position: "relative" }}>
      <button
        type="button"
        className="lp-pill"
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label && <span className="lp-lbl">{label}</span>}
        <span className="lp-val">{shown}</span>
        <svg className="lp-chev" viewBox="0 0 24 24">
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      {open && (
        <>
          <div className="lp-backdrop" onClick={() => setOpen(false)} />
          <div
            className="lp-menu"
            role="listbox"
            style={align === "right" ? { right: 0 } : { left: 0 }}
          >
            {head && <div className="lp-head">{head}</div>}
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={o.value === value ? "lp-item active" : "lp-item"}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <svg className="lp-tick" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="lp-name">{o.name}</span>
                {o.sub && <span className="lp-sub">{o.sub}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
