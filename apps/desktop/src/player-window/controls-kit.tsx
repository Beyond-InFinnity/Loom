// Shared control-bar primitives for the Loom Player.  Styling lives in the
// `.lp-*` classes in index.html (so :hover / :active / :focus-visible work);
// these components only wire behavior + the dynamic size/active bits.

import type { ReactNode } from "react";

export function IconButton({
  children,
  onClick,
  title,
  active = false,
  size = 34,
  iconSize = 20,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  title: string;
  active?: boolean;
  size?: number;
  iconSize?: number;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={active ? "lp-btn on" : "lp-btn"}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{ width: size, height: size }}
    >
      <span className="lp-ico" style={{ width: iconSize, height: iconSize }}>
        {children}
      </span>
    </button>
  );
}
