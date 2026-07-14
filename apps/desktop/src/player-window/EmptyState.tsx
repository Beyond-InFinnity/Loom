// The Player's start screen (no media loaded): a big Open button, a drag-and-
// drop hint, and the recent-files list with resume progress.  Shown centered
// over the empty video surface.

import { getRecents, removeRecent, watchedFraction } from "../player/history";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function EmptyState({
  onOpen,
  onPick,
  onRemove,
  busy,
  error,
  disabled,
  refreshKey,
}: {
  onOpen: (path: string) => void;
  onPick: () => void;
  /** Remove a recent (parent re-reads the list via refreshKey). */
  onRemove: (path: string) => void;
  busy: string | null;
  error: string | null;
  disabled: boolean;
  /** Bump to re-read the recents list (e.g. after removing one). */
  refreshKey: number;
}) {
  // refreshKey participates so the list re-reads when the parent bumps it.
  void refreshKey;
  const recents = getRecents();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        pointerEvents: "auto",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: 24,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 0.5 }}>Loom Player</div>
        <div style={{ opacity: 0.6, fontSize: 14, marginTop: 6 }}>
          Open a video, or drop one anywhere in this window
        </div>
      </div>

      <button
        onClick={onPick}
        disabled={disabled}
        style={{
          fontSize: 16,
          padding: "12px 28px",
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,0.25)",
          background: disabled ? "rgba(255,255,255,0.08)" : "rgba(126,110,255,0.9)",
          color: "#fff",
          cursor: disabled ? "default" : "pointer",
          fontWeight: 600,
        }}
      >
        Open video…
      </button>

      {recents.length > 0 && (
        <div style={{ width: "min(560px, 88vw)" }}>
          <div style={{ opacity: 0.55, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
            Recent
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recents.map((r) => {
              const frac = watchedFraction(r);
              return (
                <div
                  key={r.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  <button
                    onClick={() => onOpen(r.path)}
                    title={r.path}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: "#fff",
                      cursor: "pointer",
                      overflow: "hidden",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontSize: 14,
                      }}
                    >
                      {r.name || baseName(r.path)}
                    </span>
                    {frac > 0 && (
                      <span
                        style={{
                          height: 3,
                          borderRadius: 2,
                          background: "rgba(255,255,255,0.15)",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${Math.round(frac * 100)}%`,
                            background: "rgba(126,110,255,0.9)",
                          }}
                        />
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      removeRecent(r.path);
                      onRemove(r.path); // parent bumps refreshKey → list re-reads
                    }}
                    title="Remove from recents"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "rgba(255,255,255,0.4)",
                      cursor: "pointer",
                      fontSize: 16,
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {busy && <div style={{ opacity: 0.8 }}>{busy}</div>}
      {error && <div style={{ color: "#f88", maxWidth: 560, textAlign: "center" }}>{error}</div>}
    </div>
  );
}
