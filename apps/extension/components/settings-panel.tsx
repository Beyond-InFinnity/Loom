import { type RefObject, useEffect, useRef } from "react";

import { useCaptionStream } from "./caption-context";
import { classifyLang } from "@/lib/captions/lang-support";
import type { CaptionTrack } from "@/lib/captions/types";

// Settings panel — anchored below the pill, top-right of player.
// Diagnostic surface for 5d/5e.  Sections:
//
//   - Native language        Base BCP-47 code auto-pick uses to find
//                            the Bottom layer source.  Persisted.
//   - Target (Top)           Source-track radio list + tlang dropdown.
//   - Native (Bottom)        Source-track radio list + tlang dropdown.
//   - Colors                 Per-layer text color (swatches + custom).
//                            Persisted.
//
// Source-track switching uses discover.ts's eventsCache, so re-picking
// a previously-fetched track is instant.  tlang= changes always hit
// the network (different cache key) — first fetch ~200ms.

const LANG_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh-Hans", label: "Chinese (Simplified)" },
  { code: "zh-Hant", label: "Chinese (Traditional)" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "tr", label: "Turkish" },
  { code: "pl", label: "Polish" },
  { code: "id", label: "Indonesian" },
  { code: "he", label: "Hebrew" },
];

// Color swatches optimized for legibility over dark video content.
// User can still type any hex via the native color input below.
const COLOR_SWATCHES = [
  "#ffffff",
  "#ffe05c",
  "#5cffff",
  "#5cff9e",
  "#ff9e5c",
  "#ff5c9e",
  "#9b8aff",
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
    targetTranslateTo,
    nativeTranslateTo,
    nativeLangPref,
    topColor,
    bottomColor,
    setTargetTrack,
    setNativeTrack,
    setTargetTranslateTo,
    setNativeTranslateTo,
    setNativeLangPref,
    setTopColor,
    setBottomColor,
  } = useCaptionStream();

  const panelRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismissal.  Tricky inside a shadow root: a document-
  // level mousedown sees event.target retargeted to the shadow HOST
  // (loom-overlay-root) for any click inside the shadow tree — so we
  // can't tell pill-clicks from panel-clicks via target alone.
  // composedPath() walks through the shadow boundary so we can check
  // it against both refs.  Without the pill exemption, clicking the
  // pill to close would (a) trigger this mousedown → onClose, then (b)
  // fire the pill's onClick → re-toggle to open.
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
          {LANG_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label} ({opt.code})
            </option>
          ))}
        </select>
        <p style={hintStyle()}>
          Auto-pick matches any regional variant (en → en-US, en-GB, en-AU…).
        </p>
      </Section>

      <LayerSection
        title={`Target (Top) — ${tracks.length} tracks`}
        tracks={tracks}
        selected={selectedTarget}
        isUserPicked={isUserPickedTarget}
        onPickTrack={setTargetTrack}
        translateTo={targetTranslateTo}
        onPickTranslateTo={setTargetTranslateTo}
        allowNullTrack={false}
      />

      <LayerSection
        title="Native (Bottom)"
        tracks={tracks}
        selected={selectedNative}
        isUserPicked={isUserPickedNative}
        onPickTrack={setNativeTrack}
        translateTo={nativeTranslateTo}
        onPickTranslateTo={setNativeTranslateTo}
        allowNullTrack
        nullLabel={`(auto: tlang=${nativeLangPref} when no native track)`}
      />

      <Section title="Colors">
        <ColorRow label="Top" value={topColor} onChange={setTopColor} />
        <ColorRow
          label="Bottom"
          value={bottomColor}
          onChange={setBottomColor}
        />
      </Section>
    </div>
  );
}

// ---- Layer section --------------------------------------------------

interface LayerSectionProps {
  title: string;
  tracks: CaptionTrack[];
  selected: CaptionTrack | null;
  isUserPicked: boolean;
  onPickTrack: (track: CaptionTrack | null) => void;
  translateTo: string | null;
  onPickTranslateTo: (code: string | null) => void;
  allowNullTrack: boolean;
  nullLabel?: string;
}

function LayerSection({
  title,
  tracks,
  selected,
  isUserPicked,
  onPickTrack,
  translateTo,
  onPickTranslateTo,
  allowNullTrack,
  nullLabel,
}: LayerSectionProps) {
  return (
    <Section title={title}>
      {tracks.length === 0 ? (
        <p style={hintStyle()}>No tracks discovered yet.</p>
      ) : (
        <>
          <TrackList
            tracks={tracks}
            selected={selected}
            isUserPicked={isUserPicked}
            onPick={onPickTrack}
            allowNull={allowNullTrack}
            nullLabel={nullLabel}
          />
          <div style={translateRowStyle()}>
            <label style={translateLabelStyle()}>Translate to</label>
            <select
              value={translateTo ?? ""}
              onChange={(e) =>
                onPickTranslateTo(e.target.value === "" ? null : e.target.value)
              }
              style={selectStyle()}
            >
              <option value="">(no translation)</option>
              {LANG_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.label} ({opt.code})
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </Section>
  );
}

// ---- Sub-components -------------------------------------------------

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
          primary={nullLabel ?? "(auto)"}
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
    <button type="button" onClick={onClick} style={trackRowStyle(isSelected)}>
      <span style={trackRowDotStyle(isSelected)} />
      <span style={trackRowLabelStyle()}>
        <span style={trackPrimaryStyle()}>{primary}</span>
        {secondary ? (
          <span style={trackSecondaryStyle()}>{secondary}</span>
        ) : null}
      </span>
      {isAuto && <span style={autoBadgeStyle()}>auto</span>}
      {badge && <span style={kindBadgeStyle(badge)}>{badge}</span>}
    </button>
  );
}

interface ColorRowProps {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}

function ColorRow({ label, value, onChange }: ColorRowProps) {
  return (
    <div style={colorRowStyle()}>
      <span style={colorLabelStyle()}>{label}</span>
      <div style={swatchRowStyle()}>
        {COLOR_SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            onClick={() => onChange(hex)}
            style={swatchStyle(hex, value.toLowerCase() === hex.toLowerCase())}
            aria-label={`Set ${label} color to ${hex}`}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={colorInputStyle()}
          aria-label={`Custom ${label} color`}
        />
      </div>
    </div>
  );
}

// ---- Styles ---------------------------------------------------------

function panelStyle(): React.CSSProperties {
  return {
    position: "absolute",
    top: "52px",
    right: "16px",
    width: "320px",
    maxHeight: "min(75vh, 640px)",
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

function translateRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginTop: "8px",
  };
}

function translateLabelStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.5)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
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

function colorRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 0",
  };
}

function colorLabelStyle(): React.CSSProperties {
  return {
    flex: "0 0 50px",
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.75)",
  };
}

function swatchRowStyle(): React.CSSProperties {
  return {
    flex: "1 1 auto",
    display: "flex",
    alignItems: "center",
    gap: "5px",
    flexWrap: "wrap",
  };
}

function swatchStyle(hex: string, isSelected: boolean): React.CSSProperties {
  return {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    border: isSelected
      ? "2px solid rgba(255, 255, 255, 0.95)"
      : "1px solid rgba(255, 255, 255, 0.2)",
    background: hex,
    cursor: "pointer",
    padding: 0,
    boxShadow: isSelected ? "0 0 0 2px rgba(0, 0, 0, 0.4)" : "none",
  };
}

function colorInputStyle(): React.CSSProperties {
  return {
    width: "22px",
    height: "22px",
    border: "1px solid rgba(255, 255, 255, 0.2)",
    borderRadius: "4px",
    background: "transparent",
    padding: 0,
    cursor: "pointer",
  };
}
