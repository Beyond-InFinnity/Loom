import { type RefObject, useEffect, useRef, useState } from "react";

import { useCaptionStream } from "./caption-context";
import type { CaptionPosition } from "./caption-context";
import { classifyLang, type LangSupport } from "@/lib/captions/lang-support";
import type { CaptionTrack } from "@/lib/captions/types";

// Settings panel — anchored below the pill, top-right of player.
//
// PERF LOAD-BEARING: NO backdrop-filter ANYWHERE in this file or in
// loom-pill.tsx.  The pill is always rendered now (5f-diagnostic
// change) so it sits permanently on top of the player area, which YT
// continuously repaints during playback (progress bar tick, controls
// auto-hide, etc.).  backdrop-filter forces the browser to re-blur
// the underlying pixels on every frame of underlying paint — Firefox
// in particular has historically poor backdrop-filter perf.  The net
// effect was main-thread saturation + page input lag despite the
// video tag rendering independently on the GPU.  Solid (or near-solid
// rgba) background instead.
//
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

interface LangOption {
  code: string;
  label: string;
}

/** All Loom-compatible languages.  Engine romanization for the
    non-Latin ones (see loom_core/romanize.py); Latin-script ones get
    native-display only — they still appear because dual-subs is
    valuable even without transformation.  Chinese is split into three
    rows because the variants drive different romanization systems
    (Pinyin / Zhuyin / Jyutping) downstream.  Alphabetized by label so
    the rendered dropdown order matches reading order. */
const SUPPORTED_LANGS: LangOption[] = [
  { code: "ar", label: "Arabic" },
  { code: "be", label: "Belarusian" },
  { code: "bn", label: "Bengali" },
  { code: "bg", label: "Bulgarian" },
  { code: "yue", label: "Cantonese" },
  { code: "ca", label: "Catalan" },
  { code: "zh-Hans", label: "Chinese (Simplified)" },
  { code: "zh-Hant", label: "Chinese (Traditional)" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "fil", label: "Filipino" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "gl", label: "Galician" },
  { code: "de", label: "German" },
  { code: "gu", label: "Gujarati" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "mk", label: "Macedonian" },
  { code: "ms", label: "Malay" },
  { code: "mn", label: "Mongolian" },
  { code: "no", label: "Norwegian" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "pa", label: "Punjabi" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sr", label: "Serbian" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "es", label: "Spanish" },
  { code: "sw", label: "Swahili" },
  { code: "sv", label: "Swedish" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "vi", label: "Vietnamese" },
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

const POSITION_OPTIONS: Array<{ code: CaptionPosition; label: string }> = [
  { code: "top-1", label: "↑ Top 1" },
  { code: "top-2", label: "↑ Top 2" },
  { code: "bottom-1", label: "↓ Bot 1" },
  { code: "bottom-2", label: "↓ Bot 2" },
];

// Webkit/Firefox custom scrollbar styling for LangSelect popovers.
// Injected once via <style> inside the shadow root.  The .scrolling
// class is toggled by JS on scroll events (800ms idle debounce) so the
// scrollbar fades in while the user scrolls and fades out when idle.
// :hover provides a fallback for mouse-only interaction.
//
// Firefox uses scrollbar-color / scrollbar-width.  No native transition
// support in Firefox for those properties — the class toggle produces
// an instant cut rather than a fade.  Acceptable degradation.
const SCROLLBAR_CSS = `
.loom-langselect-list {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.0) transparent;
}
.loom-langselect-list.scrolling,
.loom-langselect-list:hover {
  scrollbar-color: rgba(255, 255, 255, 0.35) transparent;
}
.loom-langselect-list::-webkit-scrollbar {
  width: 6px;
}
.loom-langselect-list::-webkit-scrollbar-track {
  background: transparent;
}
.loom-langselect-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0);
  border-radius: 3px;
  transition: background 400ms ease;
}
.loom-langselect-list.scrolling::-webkit-scrollbar-thumb,
.loom-langselect-list:hover::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.35);
}
`;

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Ref to the pill button so the click-outside handler can ignore
      pill clicks — the pill's own onClick toggles open/closed state. */
  pillRef: RefObject<HTMLElement | null>;
  /** Plumbed from LoomApp → LoomPill → here.  "Turn off Loom on this
      tab" button at the bottom of the panel calls this; LoomApp
      unmounts the active tree on the next render. */
  onDeactivate: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  pillRef,
  onDeactivate,
}: SettingsPanelProps) {
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
    targetPosition,
    nativePosition,
    targetAnnotateEnabled,
    nativeAnnotateEnabled,
    targetPhoneticSystem,
    nativePhoneticSystem,
    setTargetTrack,
    setNativeTrack,
    setTargetTranslateTo,
    setNativeTranslateTo,
    setNativeLangPref,
    setTopColor,
    setBottomColor,
    setTargetPosition,
    setNativePosition,
    setTargetAnnotateEnabled,
    setNativeAnnotateEnabled,
    setTargetPhoneticSystem,
    setNativePhoneticSystem,
  } = useCaptionStream();

  const panelRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismissal.  Tricky inside a shadow root: a document-
  // level mousedown sees event.target retargeted to the shadow HOST
  // (loom-overlay-root) for any click inside the shadow tree — so we
  // can't tell pill-clicks from panel-clicks via target alone.
  // composedPath() walks through the shadow boundary so we can check
  // it against both refs.
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
      {/* Scoped scrollbar styling for nested LangSelect lists.  Lives
          inside the shadow root via this <style> element; no external
          stylesheet. */}
      <style>{SCROLLBAR_CSS}</style>

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
        <LangSelect
          value={nativeLangPref}
          onChange={(code) => setNativeLangPref(code)}
          options={SUPPORTED_LANGS}
        />
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

      <Section title="Position">
        <PositionRow
          label="Target"
          value={targetPosition}
          onChange={setTargetPosition}
        />
        <PositionRow
          label="Native"
          value={nativePosition}
          onChange={setNativePosition}
        />
        <p style={hintStyle()}>
          Slot 1 = upper line in its zone, slot 2 = lower.  Solo in a
          zone uses the zone's default position.
        </p>
      </Section>

      <Section title="Annotations">
        <AnnotateRow
          label="Target"
          track={selectedTarget}
          enabled={targetAnnotateEnabled}
          onToggle={setTargetAnnotateEnabled}
          phoneticSystem={targetPhoneticSystem}
          onPickPhoneticSystem={setTargetPhoneticSystem}
        />
        <AnnotateRow
          label="Native"
          track={selectedNative}
          enabled={nativeAnnotateEnabled}
          onToggle={setNativeAnnotateEnabled}
          phoneticSystem={nativePhoneticSystem}
          onPickPhoneticSystem={setNativePhoneticSystem}
        />
        <p style={hintStyle()}>
          Per-character readings (furigana, Pinyin/Zhuyin/Jyutping, RR).
          Only CJK + Korean supported in this build.  Phonetic system
          only takes effect on Chinese tracks.
        </p>
      </Section>

      <Section title="Colors">
        <ColorRow label="Top" value={topColor} onChange={setTopColor} />
        <ColorRow
          label="Bottom"
          value={bottomColor}
          onChange={setBottomColor}
        />
      </Section>

      <div style={deactivateRowStyle()}>
        <button
          type="button"
          onClick={onDeactivate}
          style={deactivateButtonStyle()}
        >
          Turn off Loom on this tab
        </button>
        <p style={hintStyle()}>
          Reactivate via the small pill that returns when you turn it
          off.  Persists across reloads of this tab.
        </p>
      </div>
    </div>
  );
}

// ---- LangSelect — custom dropdown ----------------------------------
//
// Native <select> can't be styled enough to give the fading-scrollbar
// dropdown look the diagnostic UI needs.  This custom component
// renders a button trigger + (when open) an inline-expanded list with
// a max-height set to ~10 items.  Inline rather than position:absolute
// because the panel's overflow:auto would clip an absolutely-positioned
// popover; making the dropdown part of the flow lets the panel itself
// scroll to expose the list when it opens near the bottom.

interface LangSelectProps {
  /** Current value.  Empty string represents emptyOption when set. */
  value: string;
  onChange: (value: string) => void;
  options: LangOption[];
  /** When provided, adds a sentinel row at the top with this label;
      value for that row is "" (empty string).  Used by the
      "Translate to" selects to model "(no translation)". */
  emptyOption?: { label: string };
}

const MAX_ITEMS_VISIBLE = 10;
const ITEM_HEIGHT_PX = 28;
const SCROLL_IDLE_TIMEOUT_MS = 800;

function LangSelect({ value, onChange, options, emptyOption }: LangSelectProps) {
  const [open, setOpen] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const currentLabel = (() => {
    if (value === "" && emptyOption) return emptyOption.label;
    const found = options.find((o) => o.code === value);
    return found ? `${found.label} (${found.code})` : value || "—";
  })();

  // Click-outside dismiss — same composedPath trick as the outer panel.
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const path = e.composedPath();
      if (buttonRef.current && path.includes(buttonRef.current)) return;
      if (listRef.current && path.includes(listRef.current)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handle, true);
    return () => document.removeEventListener("mousedown", handle, true);
  }, [open]);

  // Scrollbar fade — debounce scroll events.  Class toggle drives the
  // CSS transition in SCROLLBAR_CSS.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      setScrolling(true);
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(
        () => setScrolling(false),
        SCROLL_IDLE_TIMEOUT_MS,
      );
    };
    el.addEventListener("scroll", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  function pick(code: string): void {
    onChange(code);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={selectButtonStyle(open)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={selectButtonLabelStyle()}>{currentLabel}</span>
        <span style={chevronStyle(open)}>▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          className={`loom-langselect-list${scrolling ? " scrolling" : ""}`}
          style={listStyle()}
          role="listbox"
        >
          {emptyOption && (
            <LangSelectItem
              label={emptyOption.label}
              isSelected={value === ""}
              onClick={() => pick("")}
            />
          )}
          {options.map((opt) => (
            <LangSelectItem
              key={opt.code}
              label={`${opt.label} (${opt.code})`}
              isSelected={value === opt.code}
              onClick={() => pick(opt.code)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface LangSelectItemProps {
  label: string;
  isSelected: boolean;
  onClick: () => void;
}

function LangSelectItem({ label, isSelected, onClick }: LangSelectItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={langSelectItemStyle(isSelected)}
      role="option"
      aria-selected={isSelected}
    >
      <span style={trackRowDotStyle(isSelected)} />
      <span style={langSelectItemLabelStyle()}>{label}</span>
    </button>
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
            <LangSelect
              value={translateTo ?? ""}
              onChange={(code) =>
                onPickTranslateTo(code === "" ? null : code)
              }
              options={SUPPORTED_LANGS}
              emptyOption={{ label: "(no translation)" }}
            />
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
            secondary={`${track.languageCode} · ${describeProcessing(classification)}`}
            badge={track.kind === "asr" ? "asr" : "manual"}
          />
        );
      })}
    </div>
  );
}

/** Short human-readable description of the downstream romanization /
    annotation system a track will route through.  Chinese variants
    differentiated by chineseVariant (drives Pinyin vs Zhuyin vs
    Jyutping), which is the load-bearing distinction for 5d/5e plans. */
function describeProcessing(c: LangSupport): string {
  if (c.family === "cjk-han") {
    if (c.chineseVariant === "simplified") return "Pinyin";
    if (c.chineseVariant === "traditional") return "Zhuyin";
    if (c.chineseVariant === "cantonese") return "Jyutping";
  }
  if (c.family === "kana") return "Romaji";
  if (c.family === "hangul") return "RR (Romanization)";
  if (c.family === "cyrillic") return "Cyrillic translit";
  if (c.family === "thai") return "Thai translit";
  if (c.family === "hebrew") return "Hebrew translit";
  if (c.family === "arabic") return "Arabic translit";
  if (c.family === "indic") return "IAST";
  if (c.processing === "native-display") return "Latin (no romanize)";
  return "no romanizer yet";
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

interface PositionRowProps {
  label: string;
  value: CaptionPosition;
  onChange: (pos: CaptionPosition) => void;
}

function PositionRow({ label, value, onChange }: PositionRowProps) {
  return (
    <div style={positionRowStyle()}>
      <span style={positionLabelStyle()}>{label}</span>
      <div style={positionButtonsStyle()}>
        {POSITION_OPTIONS.map((opt) => (
          <button
            key={opt.code}
            type="button"
            onClick={() => onChange(opt.code)}
            style={positionButtonStyle(value === opt.code)}
            aria-pressed={value === opt.code}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- AnnotateRow ----------------------------------------------------

interface AnnotateRowProps {
  label: string;
  /** Track currently assigned to this layer.  Used to (a) compute
      whether annotation is meaningful for this track's language, and
      (b) show a "(not annotatable)" hint when not. */
  track: CaptionTrack | null;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  phoneticSystem: string | null;
  onPickPhoneticSystem: (code: string | null) => void;
}

/** Phonetic-system options for the annotation dropdown.  "" sentinel
    represents "Auto" (null on the wire — backend picks the lang's
    default).  pinyin/zhuyin/jyutping are the meaningful overrides for
    Chinese variants; selecting them on ja/ko is harmless (backend
    falls back to default).  Thai's paiboon/rtgs/ipa are deferred
    until Thai annotation lands. */
const PHONETIC_SYSTEM_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "pinyin", label: "Pinyin (Mandarin Simplified default)" },
  { code: "zhuyin", label: "Zhuyin (Mandarin Traditional default)" },
  { code: "jyutping", label: "Jyutping (Cantonese)" },
];

function AnnotateRow({
  label,
  track,
  enabled,
  onToggle,
  phoneticSystem,
  onPickPhoneticSystem,
}: AnnotateRowProps) {
  const annotatable = track
    ? classifyLang(track.languageCode).processing === "annotate-romanize"
    : false;
  // Disabled visual state when there's no track yet OR the language
  // isn't annotatable.  Toggle still functional in case the user
  // wants to flip it ahead of switching to an annotatable track.
  const dim = !annotatable;

  return (
    <div style={annotateRowStyle(dim)}>
      <div style={annotateHeaderStyle()}>
        <span style={annotateLabelStyle()}>{label}</span>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          style={annotateToggleStyle(enabled)}
          aria-pressed={enabled}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
      {!annotatable && (
        <p style={hintStyle()}>
          {track
            ? `${track.languageCode}: not annotatable in this build.`
            : "(pick a track first)"}
        </p>
      )}
      {annotatable && (
        <div style={annotateSystemRowStyle()}>
          <span style={annotateSystemLabelStyle()}>Phonetic system</span>
          <LangSelect
            value={phoneticSystem ?? ""}
            onChange={(code) =>
              onPickPhoneticSystem(code === "" ? null : code)
            }
            options={PHONETIC_SYSTEM_OPTIONS}
            emptyOption={{ label: "Auto (from track language)" }}
          />
        </div>
      )}
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
    // The shadow host is sized to #movie_player (which has
    // overflow: hidden), so anything taller than the player gets
    // clipped at the bottom.  calc(100% - 72px) ensures the panel
    // never exceeds the player height minus the 52px top offset and
    // ~20px bottom buffer — fits on default-mode players (~480-720px
    // tall) without the bottom UI being cut off.
    maxHeight: "min(75vh, 640px, calc(100% - 72px))",
    overflowY: "auto",
    zIndex: 2147483647,
    // No backdrop-filter — see file header.  rgba(...) at 0.97 reads
    // as solid enough on every video without the per-frame blur cost
    // of compositing the player area underneath.
    background: "rgba(20, 20, 24, 0.97)",
    color: "#fff",
    borderRadius: "10px",
    padding: "12px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    lineHeight: 1.4,
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.6)",
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

function selectButtonStyle(open: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 8px",
    borderRadius: "6px",
    border: open
      ? "1px solid rgba(93, 255, 170, 0.4)"
      : "1px solid rgba(255, 255, 255, 0.12)",
    background: "rgba(255, 255, 255, 0.06)",
    color: "#fff",
    fontSize: "12px",
    fontFamily: "inherit",
    outline: "none",
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 120ms ease",
  };
}

function selectButtonLabelStyle(): React.CSSProperties {
  return {
    flex: "1 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

function chevronStyle(open: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.5)",
    transform: open ? "rotate(180deg)" : "rotate(0deg)",
    transition: "transform 160ms ease",
  };
}

function listStyle(): React.CSSProperties {
  return {
    marginTop: "4px",
    // Internal scroll cap at ~10 items.  Each item is 28px (padding +
    // text) + 4px gap between → ~28px per row; plus 4px top + 4px
    // bottom padding around the list.
    maxHeight: `${MAX_ITEMS_VISIBLE * ITEM_HEIGHT_PX + 8}px`,
    overflowY: "auto",
    background: "rgba(28, 28, 32, 0.98)",
    borderRadius: "6px",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    padding: "4px",
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.4)",
    pointerEvents: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  };
}

function langSelectItemStyle(isSelected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 8px",
    minHeight: "24px",
    borderRadius: "4px",
    border: "1px solid transparent",
    background: isSelected
      ? "rgba(93, 255, 170, 0.12)"
      : "transparent",
    borderColor: isSelected ? "rgba(93, 255, 170, 0.35)" : "transparent",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
    textAlign: "left",
    width: "100%",
  };
}

function langSelectItemLabelStyle(): React.CSSProperties {
  return {
    flex: "1 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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

function positionRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 0",
  };
}

function positionLabelStyle(): React.CSSProperties {
  return {
    flex: "0 0 50px",
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.75)",
  };
}

function positionButtonsStyle(): React.CSSProperties {
  return {
    flex: "1 1 auto",
    display: "flex",
    gap: "4px",
    flexWrap: "wrap",
  };
}

function positionButtonStyle(isSelected: boolean): React.CSSProperties {
  return {
    flex: "1 1 0",
    minWidth: "48px",
    padding: "5px 6px",
    borderRadius: "4px",
    border: isSelected
      ? "1px solid rgba(93, 255, 170, 0.45)"
      : "1px solid rgba(255, 255, 255, 0.12)",
    background: isSelected
      ? "rgba(93, 255, 170, 0.15)"
      : "rgba(255, 255, 255, 0.04)",
    color: isSelected ? "#5dffaa" : "#fff",
    fontSize: "11px",
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
  };
}

function annotateRowStyle(dim: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px",
    borderRadius: "6px",
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(255, 255, 255, 0.06)",
    marginBottom: "6px",
    opacity: dim ? 0.65 : 1,
  };
}

function annotateHeaderStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  };
}

function annotateLabelStyle(): React.CSSProperties {
  return {
    fontSize: "12px",
    fontWeight: 500,
    color: "rgba(255, 255, 255, 0.85)",
  };
}

function annotateToggleStyle(enabled: boolean): React.CSSProperties {
  return {
    minWidth: "48px",
    padding: "4px 10px",
    borderRadius: "999px",
    border: enabled
      ? "1px solid rgba(93, 255, 170, 0.45)"
      : "1px solid rgba(255, 255, 255, 0.18)",
    background: enabled
      ? "rgba(93, 255, 170, 0.18)"
      : "rgba(255, 255, 255, 0.05)",
    color: enabled ? "#5dffaa" : "rgba(255, 255, 255, 0.6)",
    fontSize: "11px",
    fontFamily: "inherit",
    fontWeight: 600,
    letterSpacing: "0.04em",
    cursor: "pointer",
    textTransform: "uppercase",
  };
}

function annotateSystemRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  };
}

function annotateSystemLabelStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.5)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };
}

function deactivateRowStyle(): React.CSSProperties {
  return {
    marginTop: "8px",
    paddingTop: "10px",
    borderTop: "1px solid rgba(255, 255, 255, 0.06)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  };
}

function deactivateButtonStyle(): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "6px",
    border: "1px solid rgba(255, 122, 122, 0.35)",
    background: "rgba(255, 122, 122, 0.1)",
    color: "#ff9e9e",
    fontFamily: "inherit",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
  };
}
