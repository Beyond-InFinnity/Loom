import { type RefObject, useEffect, useRef } from "react";

import { useCaptionStream } from "./caption-context";
import { classifyLang } from "@/lib/captions/lang-support";
import type { CaptionTrack } from "@/lib/captions/types";

// Settings panel — anchored below the pill, top-right of player.
// Pulls 5f forward as a diagnostic surface for 5d/5e: lets the user
// override which target track lands in the Top layer and which native
// track lands in the Bottom layer.  Also exposes the native-language
// preference (persisted to browser.storage.local) used by auto-pick.
//
// Two sections — Target and Native — each a vertical list of the
// video's discovered tracks.  Currently-selected track highlighted;
// (auto) badge marks the auto-pick when no user override is set.
// Manual / ASR distinguished via a small label badge.
//
// Re-selection is cheap: discover.ts's eventsCache means switching to
// a previously-fetched track is instant, no network round-trip.

const NATIVE_LANG_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
];

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Ref to the pill button so the click-outside handler can ignore
      pill clicks — the pill's own onClick toggles open/closed state. */
  pillRef: RefObject<HTMLElement | null>;
}

export function SettingsPanel({ open, onClose, pillRef }: SettingsPanelProps) {
  const {
    tracks,
    selectedTarget,
    selectedNative,
    isUserPickedTarget,
    isUserPickedNative,
    nativeLangPref,
    setTargetTrack,
    setNativeTrack,
    setNativeLangPref,
  } = useCaptionStream();

  const panelRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismissal.  Tricky inside a shadow root: a document-
  // level mousedown sees event.target retargeted to the shadow HOST
  // (loom-overlay-root) for any click anywhere inside the shadow tree
  // — so we can't tell pill-clicks from panel-clicks via target alone.
  // composedPath() walks through the shadow boundary and returns the
  // real chain, so we check it against both the panel ref and the pill
  // ref.  Without the pill exemption, clicking the pill (to toggle
  // closed) would (a) trigger this mousedown → onClose, then (b) fire
  // the pill's onClick → toggle to open, net result: panel re-opens
  // instead of closing.
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      const path = e.composedPath();
      if (panelRef.current && path.includes(panelRef.current)) return;
      if (pillRef.current && path.includes(pillRef.current)) return;
      onClose();
    };
    document.addEventListener("mousedown", handleDown, true);
    return () => document.removeEventListener("mousedown", handleDown, true);
  }, [open, onClose, pillRef]);

  if (!open) return null;

  return (
    <div ref={panelRef} style={panelStyle()}>
      <div style={headerStyle()}>
        <span>Loom settings</span>
        <button
          type="button"
          onClick={onClose}
          style={closeButtonStyle()}
          aria-label="Close settings"
        >
          ×
        </button>
      </div>

      <Section title="Native language (auto-pick base)">
        <select
          value={nativeLangPref}
          onChange={(e) => setNativeLangPref(e.target.value)}
          style={selectStyle()}
        >
          {NATIVE_LANG_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label} ({opt.code})
            </option>
          ))}
        </select>
        <p style={hintStyle()}>
          Auto-pick matches any regional variant (en → en-US, en-GB, en-AU…).
        </p>
      </Section>

      <Section title={`Target (Top) — ${tracks.length} tracks`}>
        {tracks.length === 0 ? (
          <p style={hintStyle()}>No tracks discovered yet.</p>
        ) : (
          <TrackList
            tracks={tracks}
            selected={selectedTarget}
            isUserPicked={isUserPickedTarget}
            onPick={setTargetTrack}
          />
        )}
      </Section>

      <Section title="Native (Bottom)">
        {tracks.length === 0 ? (
          <p style={hintStyle()}>No tracks discovered yet.</p>
        ) : (
          <TrackList
            tracks={tracks}
            selected={selectedNative}
            isUserPicked={isUserPickedNative}
            onPick={setNativeTrack}
            allowNull
            nullLabel={`(auto-translate via tlang=${nativeLangPref})`}
          />
        )}
      </Section>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div style={sectionStyle()}>
      <div style={sectionTitleStyle()}>{title}</div>
      {children}
    </div>
  );
}

interface TrackListProps {
  tracks: CaptionTrack[];
  selected: CaptionTrack | null;
  isUserPicked: boolean;
  onPick: (track: CaptionTrack | null) => void;
  allowNull?: boolean;
  nullLabel?: string;
}

function TrackList({
  tracks,
  selected,
  isUserPicked,
  onPick,
  allowNull = false,
  nullLabel,
}: TrackListProps) {
  return (
    <div style={trackListStyle()}>
      {allowNull && (
        <TrackRow
          isSelected={selected === null}
          isAuto={!isUserPicked && selected === null}
          onClick={() => onPick(null)}
          primary={nullLabel ?? "(none)"}
          secondary=""
          badge={null}
        />
      )}
      {tracks.map((track) => {
        const isSelected =
          selected !== null && selected.languageCode === track.languageCode;
        const classification = classifyLang(track.languageCode);
        return (
          <TrackRow
            key={`${track.languageCode}::${track.kind}`}
            isSelected={isSelected}
            isAuto={!isUserPicked && isSelected}
            onClick={() => onPick(track)}
            primary={track.name}
            secondary={`${track.languageCode} · ${classification.processing}`}
            badge={track.kind === "asr" ? "asr" : "manual"}
          />
        );
      })}
    </div>
  );
}

interface TrackRowProps {
  isSelected: boolean;
  isAuto: boolean;
  onClick: () => void;
  primary: string;
  secondary: string;
  badge: "manual" | "asr" | null;
}

function TrackRow({
  isSelected,
  isAuto,
  onClick,
  primary,
  secondary,
  badge,
}: TrackRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={trackRowStyle(isSelected)}
    >
      <span style={trackRowDotStyle(isSelected)} />
      <span style={trackRowLabelStyle()}>
        <span style={trackPrimaryStyle()}>{primary}</span>
        {secondary ? <span style={trackSecondaryStyle()}>{secondary}</span> : null}
      </span>
      {isAuto && <span style={autoBadgeStyle()}>auto</span>}
      {badge && <span style={kindBadgeStyle(badge)}>{badge}</span>}
    </button>
  );
}

// ---- Styles ---------------------------------------------------------

function panelStyle(): React.CSSProperties {
  return {
    position: "absolute",
    top: "52px",
    right: "16px",
    width: "320px",
    maxHeight: "min(70vh, 560px)",
    overflowY: "auto",
    zIndex: 2147483647,
    background: "rgba(20, 20, 24, 0.96)",
    color: "#fff",
    borderRadius: "10px",
    padding: "12px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    lineHeight: 1.4,
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    pointerEvents: "auto",
    userSelect: "none",
  };
}

function headerStyle(): React.CSSProperties {
  return {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "10px",
    fontSize: "13px",
    fontWeight: 600,
    letterSpacing: "0.02em",
  };
}

function closeButtonStyle(): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "rgba(255, 255, 255, 0.6)",
    cursor: "pointer",
    fontSize: "18px",
    lineHeight: 1,
    padding: "0 4px",
  };
}

function sectionStyle(): React.CSSProperties {
  return { marginBottom: "12px" };
}

function sectionTitleStyle(): React.CSSProperties {
  return {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "rgba(255, 255, 255, 0.55)",
    marginBottom: "6px",
  };
}

function selectStyle(): React.CSSProperties {
  return {
    width: "100%",
    padding: "6px 8px",
    borderRadius: "6px",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    background: "rgba(255, 255, 255, 0.06)",
    color: "#fff",
    fontSize: "12px",
    fontFamily: "inherit",
    outline: "none",
  };
}

function hintStyle(): React.CSSProperties {
  return {
    margin: "4px 0 0 0",
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.4)",
  };
}

function trackListStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  };
}

function trackRowStyle(isSelected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    borderRadius: "6px",
    border: "1px solid transparent",
    background: isSelected
      ? "rgba(93, 255, 170, 0.12)"
      : "rgba(255, 255, 255, 0.03)",
    borderColor: isSelected ? "rgba(93, 255, 170, 0.35)" : "transparent",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
    textAlign: "left",
    width: "100%",
  };
}

function trackRowDotStyle(isSelected: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: isSelected ? "#5dffaa" : "rgba(255, 255, 255, 0.18)",
    boxShadow: isSelected ? "0 0 6px rgba(93, 255, 170, 0.7)" : "none",
  };
}

function trackRowLabelStyle(): React.CSSProperties {
  return {
    flex: "1 1 auto",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  };
}

function trackPrimaryStyle(): React.CSSProperties {
  return {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

function trackSecondaryStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.45)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

function autoBadgeStyle(): React.CSSProperties {
  return {
    flex: "0 0 auto",
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "rgba(93, 255, 170, 0.85)",
    padding: "2px 5px",
    borderRadius: "999px",
    border: "1px solid rgba(93, 255, 170, 0.4)",
  };
}

function kindBadgeStyle(kind: "manual" | "asr"): React.CSSProperties {
  return {
    flex: "0 0 auto",
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    padding: "2px 5px",
    borderRadius: "4px",
    background:
      kind === "manual"
        ? "rgba(93, 138, 255, 0.18)"
        : "rgba(255, 180, 80, 0.18)",
    color: kind === "manual" ? "#9bb8ff" : "#ffc474",
    border: `1px solid ${
      kind === "manual"
        ? "rgba(93, 138, 255, 0.35)"
        : "rgba(255, 180, 80, 0.35)"
    }`,
  };
}
