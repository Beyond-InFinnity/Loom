// Inline SVG icon set for the Loom Player control chrome.  Feather-weight
// line icons on a 24×24 grid, drawn in `currentColor` so an IconButton's color
// (and its accent-on state) flows straight through — no icon fonts, no emoji.
// Each icon fills its parent box (the `.lp-ico` span sets the pixel size).

import type { ReactNode } from "react";

function Line({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function Solid({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
      {children}
    </svg>
  );
}

export const PlayIcon = () => (
  <Solid>
    <path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5Z" />
  </Solid>
);

export const PauseIcon = () => (
  <Solid>
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </Solid>
);

export const PrevIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 5.5v13a.6.6 0 0 1-.92.5L8 13.2V18a.8.8 0 0 1-1.6 0V6a.8.8 0 0 1 1.6 0v4.8l9.08-5.8a.6.6 0 0 1 .92.5Z" stroke="none" />
  </svg>
);

export const NextIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 5.5v13a.6.6 0 0 0 .92.5L16 13.2V18a.8.8 0 0 0 1.6 0V6a.8.8 0 0 0-1.6 0v4.8L6.92 5A.6.6 0 0 0 6 5.5Z" stroke="none" />
  </svg>
);

export const VolumeIcon = () => (
  <Line>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4a0 0 0 0 1 0 0V9.5Z" fill="currentColor" stroke="currentColor" />
    <path d="M15.5 9a4 4 0 0 1 0 6" />
    <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Line>
);

export const MuteIcon = () => (
  <Line>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4V9.5Z" fill="currentColor" stroke="currentColor" />
    <line x1="16" y1="9.5" x2="21" y2="14.5" />
    <line x1="21" y1="9.5" x2="16" y2="14.5" />
  </Line>
);

export const LoopIcon = () => (
  <Line>
    <polyline points="17 2 21 6 17 10" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 22 3 18 7 14" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </Line>
);

export const FolderIcon = () => (
  <Line>
    <path d="M3 7.5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6l1 1a2 2 0 0 0 1.4.6H19a2 2 0 0 1 2 2v6.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Line>
);

export const GearIcon = () => (
  <Line>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Line>
);

export const MaximizeIcon = () => (
  <Line>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </Line>
);

export const MinimizeIcon = () => (
  <Line>
    <path d="M3 8h3a2 2 0 0 0 2-2V3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
  </Line>
);

export const CloseIcon = () => (
  <Line>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </Line>
);
