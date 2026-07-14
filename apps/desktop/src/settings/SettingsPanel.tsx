// Loom Player settings — the desktop (Tauri main-window) settings UI, built to
// REPRODUCE the browser-extension settings panel (apps/extension/components/
// settings-panel.tsx): collapsed-first sections + line-cards, each with a rich
// one-line summary; mint-green `#5dffaa` for selection, the Switch's own
// purple/gold vocabulary; the swatch-strip + `◐` react-colorful wheel color
// control; custom inline dropdowns (never native <select>); each line-card owns
// ALL of its line's controls.  Writes the shared cross-window store (host.ts);
// the player window reads the same keys and re-renders live.  Isolated from the
// extension (no caption-context import) so the extension carries zero risk —
// but the visual language is transcribed value-for-value.
//
// Player-specific vs the extension: track selection is real here (the loaded
// file's embedded + external tracks, published by the player window via
// publishTracks); everything drives the same `loom_*` keys.

import { Fragment, useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { fetchPresetCatalog } from "@loom/player-ui/presets/fetch";
import type { Preset, PresetCatalog } from "@loom/player-ui/presets/types";
import { languageName } from "@loom/player-ui/i18n";
import {
  classifyLang,
  phoneticSystemsFor,
  phoneticSystemLabelFor,
  type LangSupport,
} from "@loom/player-ui/captions/lang-support";
import {
  applyLayerColors,
  LOOMINATE_DEFAULT_PRESET,
  LOOMINATE_DEFAULT_PRESET_ID,
  usePlayerTracks,
  useSetting,
  type CaptionPosition,
  type LongVowelMode,
  type PublishedTrack,
  type SettingName,
} from "./model";
import { readCached, storage } from "../player/host";

// ---- static option lists ------------------------------------------------
// All Loom-compatible languages (same set as the extension), alphabetized by
// the localized display name at render time.
const SUPPORTED_LANG_CODES: string[] = [
  "ar", "be", "bn", "bg", "yue", "ca", "zh-Hans", "zh-Hant", "hr", "cs", "da",
  "nl", "en", "fil", "fi", "fr", "gl", "de", "gu", "he", "hi", "hu", "id", "it",
  "ja", "ko", "mk", "ms", "mn", "no", "fa", "pl", "pt", "pa", "ro", "ru", "sr",
  "sk", "sl", "es", "sw", "sv", "ta", "te", "th", "tr", "uk", "ur", "vi",
];
function supportedLangs(): DropdownOption[] {
  return SUPPORTED_LANG_CODES.map((code) => ({ code, label: languageName(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const COLOR_SWATCHES = [
  "#ffffff", "#ffe05c", "#5cffff", "#5cff9e", "#ff9e5c", "#ff5c9e", "#9b8aff",
];

const POSITIONS: { code: CaptionPosition; label: string }[] = [
  { code: "top-1", label: "Top ①" },
  { code: "top-2", label: "Top ②" },
  { code: "bottom-1", label: "Bottom ①" },
  { code: "bottom-2", label: "Bottom ②" },
];

function fontFamilyOptions(): DropdownOption[] {
  return [
    { code: "auto", label: "Auto (Noto fallback)" },
    { code: "'Noto Sans JP', sans-serif", label: "Noto Sans JP" },
    { code: "'Noto Sans SC', sans-serif", label: "Noto Sans SC (Simplified)" },
    { code: "'Noto Sans TC', sans-serif", label: "Noto Sans TC (Traditional)" },
    { code: "'Noto Sans KR', sans-serif", label: "Noto Sans KR" },
    { code: "'Noto Sans Thai', sans-serif", label: "Noto Sans Thai" },
    { code: "'Noto Serif JP', serif", label: "Noto Serif JP" },
    { code: "'Noto Serif', serif", label: "Noto Serif" },
    { code: "sans-serif", label: "System sans" },
    { code: "serif", label: "System serif" },
    { code: "monospace", label: "System monospace" },
    { code: "Arial, sans-serif", label: "Arial" },
    { code: "Georgia, serif", label: "Georgia" },
    { code: "'Times New Roman', serif", label: "Times New Roman" },
  ];
}

const LONG_VOWELS: DropdownOption[] = [
  { code: "macrons", label: "Macrons (ō)" },
  { code: "doubled", label: "Doubled (ou)" },
  { code: "unmarked", label: "Unmarked (o)" },
];

// ---- collapse-state persistence (shared store, cross-window) -------------
const COLLAPSE_KEY = "loom_player_collapsed_sections";
const SECTION_IDS = [
  "native", "video-track", "native-track", "position", "size", "presets",
  "bottom", "top", "annotation", "romanization",
] as const;
type SectionId = (typeof SECTION_IDS)[number];

function allCollapsed(): Record<string, boolean> {
  return Object.fromEntries(SECTION_IDS.map((id) => [id, true]));
}
function readCollapsed(): Record<string, boolean> {
  const stored = readCached<Record<string, boolean> | null>(COLLAPSE_KEY, null);
  return stored ? { ...allCollapsed(), ...stored } : allCollapsed();
}

// ---- panel --------------------------------------------------------------
export function SettingsPanel() {
  const tracks = usePlayerTracks();
  const [targetId, setTargetId] = useSetting("targetTrackId");
  const [nativeId, setNativeId] = useSetting("nativeTrackId");
  const [nativeLangPref, setNativeLangPref] = useSetting("nativeLangPref");

  // The video language = the selected Top track's language (falls back to ja,
  // the study default).  Drives presets + phonetic-system + long-vowel — so
  // the panel adapts to whatever the file actually is.
  const videoLang =
    tracks.find((t) => t.id === targetId)?.languageCode ?? "ja";
  const nativeLang = nativeLangPref || navigator.language.split("-")[0] || "en";

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readCollapsed(),
  );
  useEffect(
    () =>
      storage.onChanged((changes: Record<string, unknown>) => {
        if (COLLAPSE_KEY in changes) setCollapsed(readCollapsed());
      }),
    [],
  );
  const section = (id: SectionId) => ({
    collapsed: collapsed[id] ?? true,
    onToggleCollapse: () => {
      const next = { ...collapsed, [id]: !(collapsed[id] ?? true) };
      setCollapsed(next);
      void storage.set({ [COLLAPSE_KEY]: next });
    },
  });

  return (
    <div style={S.panel}>
      <div style={S.header}>Player subtitle settings</div>
      <div style={S.subheader}>Changes apply live to the player window.</div>

      <Section
        {...section("native")}
        title="Your language"
        summary={<TextSummary>{languageName(nativeLang)}</TextSummary>}
      >
        <Dropdown
          value={nativeLang}
          onChange={setNativeLangPref}
          options={supportedLangs()}
        />
        <p style={S.hint}>The language you speak — used to auto-pick the Bottom subtitle track.</p>
      </Section>

      <TrackPicker
        {...section("video-track")}
        title={`Video language (${tracks.length} track${tracks.length === 1 ? "" : "s"})`}
        tracks={tracks}
        selectedId={targetId}
        onPick={(id) => setTargetId(id)}
        summary={
          <TextSummary>
            {tracks.find((t) => t.id === targetId)
              ? languageName(videoLang)
              : "—"}
          </TextSummary>
        }
      />

      <TrackPicker
        {...section("native-track")}
        title="Your language subtitles"
        tracks={tracks}
        selectedId={nativeId}
        onPick={(id) => setNativeId(id)}
        allowNone
        noneLabel="Auto / none"
        summary={
          <TextSummary>
            {tracks.find((t) => t.id === nativeId)
              ? languageName(tracks.find((t) => t.id === nativeId)!.languageCode)
              : "—"}
          </TextSummary>
        }
      />

      <PositionSection {...section("position")} />
      <SizeSection {...section("size")} />
      <PresetsSection {...section("presets")} videoLang={videoLang} />

      <LineCard
        {...section("bottom")}
        title="Bottom · your language"
        sizeMode="px"
        color="bottomColor"
        alpha="bottomAlpha"
        size="bottomFontSizePx"
        font="bottomFontFamily"
        outlineColor="bottomOutlineColor"
        outlineAlpha="bottomOutlineAlpha"
        glowRadius="bottomGlowRadius"
        glowColor="bottomGlowColor"
        glowAlpha="bottomGlowAlpha"
        enable="bottomLineEnabled"
      />
      <LineCard
        {...section("top")}
        title="Top · video language"
        sizeMode="px"
        color="topColor"
        alpha="topAlpha"
        size="topFontSizePx"
        font="topFontFamily"
        outlineColor="topOutlineColor"
        outlineAlpha="topOutlineAlpha"
        glowRadius="topGlowRadius"
        glowColor="topGlowColor"
        glowAlpha="topGlowAlpha"
        enable="topLineEnabled"
      />
      <LineCard
        {...section("annotation")}
        title="Annotation · furigana / ruby"
        sizeMode="ratio"
        color="annotationColor"
        alpha="annotationAlpha"
        size="annotationFontRatio"
        font="annotationFontFamily"
        outlineColor="annotationOutlineColor"
        outlineAlpha="annotationOutlineAlpha"
        glowRadius="annotationGlowRadius"
        glowColor="annotationGlowColor"
        glowAlpha="annotationGlowAlpha"
        enable="targetAnnotateEnabled"
      />
      <LineCard
        {...section("romanization")}
        title="Romanization · phonetic line"
        sizeMode="ratio"
        color="romanizationColor"
        alpha="romanizationAlpha"
        size="romanizationFontRatio"
        font="romanizationFontFamily"
        outlineColor="romanizationOutlineColor"
        outlineAlpha="romanizationOutlineAlpha"
        glowRadius="romanizationGlowRadius"
        glowColor="romanizationGlowColor"
        glowAlpha="romanizationGlowAlpha"
        enable="targetRomanizeEnabled"
      >
        <RomanizationControls videoLang={videoLang} />
      </LineCard>
    </div>
  );
}

// ---- collapsible section shell ------------------------------------------
interface CollapseProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function Section({
  title,
  collapsed,
  onToggleCollapse,
  summary,
  trailing,
  children,
}: CollapseProps & {
  title: string;
  summary?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={S.section}>
      <div style={S.headerRow}>
        <button
          type="button"
          onClick={onToggleCollapse}
          style={collapsibleHeaderStyle(collapsed)}
          aria-expanded={!collapsed}
        >
          <span style={S.chevron} aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          <span style={S.sectionTitle}>{title}</span>
        </button>
        {(summary != null || trailing != null) && (
          <div style={S.headerTrailing}>
            {collapsed && summary}
            {trailing}
          </div>
        )}
      </div>
      {!collapsed && <div style={S.sectionBody}>{children}</div>}
    </div>
  );
}

function TextSummary({ children }: { children: React.ReactNode }) {
  return <span style={S.summaryText}>{children}</span>;
}

// ---- Dropdown — custom inline select (button + expanding list) ----------
interface DropdownOption {
  code: string;
  label: string;
}

function Dropdown({
  value,
  onChange,
  options,
  emptyLabel,
}: {
  value: string;
  onChange: (code: string) => void;
  options: DropdownOption[];
  /** sentinel row with code "" at the top */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.code === value);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const path = e.composedPath();
      if (btnRef.current && path.includes(btnRef.current)) return;
      if (listRef.current && path.includes(listRef.current)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handle, true);
    return () => document.removeEventListener("mousedown", handle, true);
  }, [open]);

  const rows = emptyLabel ? [{ code: "", label: emptyLabel }, ...options] : options;

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={selectButtonStyle(open)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={S.selectLabel}>
          {current ? current.label : emptyLabel ?? "—"}
        </span>
        <span style={chevronRotStyle(open)}>▾</span>
      </button>
      {open && (
        <div ref={listRef} style={S.list} role="listbox">
          {rows.map((opt) => {
            const sel = opt.code === value;
            return (
              <button
                key={opt.code || "__empty"}
                type="button"
                onClick={() => {
                  onChange(opt.code);
                  setOpen(false);
                }}
                style={listItemStyle(sel)}
                role="option"
                aria-selected={sel}
              >
                <span style={dotStyle(sel)} />
                <span style={S.listItemLabel}>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- track pickers ------------------------------------------------------
function describeProcessing(c: LangSupport): string {
  if (c.family === "cjk-han") {
    if (c.chineseVariant === "simplified") return "Pinyin";
    if (c.chineseVariant === "traditional") return "Zhuyin";
    if (c.chineseVariant === "cantonese") return "Jyutping";
  }
  if (c.family === "kana") return "Romaji";
  if (c.family === "hangul") return "Korean Roman";
  if (c.family === "cyrillic") return "Cyrillic translit";
  if (c.family === "thai") return "Thai translit";
  if (c.family === "hebrew") return "Hebrew translit";
  if (c.family === "arabic") return "Arabic translit";
  if (c.family === "indic") return "Indic Roman (IAST)";
  if (c.processing === "native-display") return "Native (no romanization)";
  return "No romanization";
}

function TrackPicker({
  title,
  tracks,
  selectedId,
  onPick,
  allowNone,
  noneLabel,
  summary,
  collapsed,
  onToggleCollapse,
}: CollapseProps & {
  title: string;
  tracks: PublishedTrack[];
  selectedId: string | null;
  onPick: (id: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  summary?: React.ReactNode;
}) {
  return (
    <Section title={title} collapsed={collapsed} onToggleCollapse={onToggleCollapse} summary={summary}>
      {tracks.length === 0 ? (
        <p style={S.hint}>Open a video to choose its subtitle tracks.</p>
      ) : (
        <div style={S.trackList}>
          {allowNone && (
            <TrackRow
              selected={selectedId === null}
              onClick={() => onPick(null)}
              primary={noneLabel ?? "None"}
              secondary=""
            />
          )}
          {tracks.map((track) => (
            <TrackRow
              key={track.id}
              selected={selectedId === track.id}
              onClick={() => onPick(track.id)}
              primary={track.name}
              secondary={`${track.languageCode} · ${describeProcessing(classifyLang(track.languageCode))}`}
              badge={track.kind === "asr" ? "asr" : "manual"}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function TrackRow({
  selected,
  onClick,
  primary,
  secondary,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  primary: string;
  secondary: string;
  badge?: "manual" | "asr";
}) {
  return (
    <button type="button" onClick={onClick} style={trackRowStyle(selected)}>
      <span style={dotStyle(selected)} />
      <span style={S.trackLabel}>
        <span style={S.trackPrimary}>{primary}</span>
        {secondary && <span style={S.trackSecondary}>{secondary}</span>}
      </span>
      {badge && <span style={kindBadgeStyle(badge)}>{badge}</span>}
    </button>
  );
}

// ---- position + size ----------------------------------------------------
function PositionSection(props: CollapseProps) {
  const [target, setTarget] = useSetting("targetPosition");
  const [nativePos, setNativePos] = useSetting("nativePosition");
  const [topNudge, setTopNudge] = useSetting("topPositionOffsetPct");
  const [botNudge, setBotNudge] = useSetting("bottomPositionOffsetPct");
  const [spacing, setSpacing] = useSetting("lineSpacingPx");
  const arrow = (p: CaptionPosition) => (p.startsWith("top") ? "↑" : "↓");

  return (
    <Section
      {...props}
      title="Position"
      summary={
        <>
          <span style={colorDotStyle("#5dffaa")} aria-hidden="true" />
          <TextSummary>{arrow(target)} {arrow(nativePos)}</TextSummary>
        </>
      }
    >
      <PositionRow label="Video line" value={target} onChange={setTarget} />
      <PositionRow label="Your line" value={nativePos} onChange={setNativePos} />
      <RangeRow label="Top nudge" value={topNudge} min={-40} max={40} step={1}
        onChange={setTopNudge} hint={`${topNudge > 0 ? "+" : ""}${topNudge}%`} />
      <RangeRow label="Bottom nudge" value={botNudge} min={-40} max={40} step={1}
        onChange={setBotNudge} hint={`${botNudge > 0 ? "+" : ""}${botNudge}%`} />
      <RangeRow label="Line spacing" value={spacing} min={0} max={40} step={1}
        onChange={setSpacing} hint={`${spacing}px`} />
    </Section>
  );
}

function PositionRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CaptionPosition;
  onChange: (v: CaptionPosition) => void;
}) {
  return (
    <div style={S.positionRow}>
      <span style={S.positionLabel}>{label}</span>
      <div style={S.positionButtons}>
        {POSITIONS.map((p) => (
          <button
            key={p.code}
            type="button"
            onClick={() => onChange(p.code)}
            style={positionButtonStyle(value === p.code)}
            aria-pressed={value === p.code}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SizeSection(props: CollapseProps) {
  const [size, setSize] = useSetting("captionSizePct");
  return (
    <Section {...props} title="Size" summary={<TextSummary>{size}%</TextSummary>}>
      <RangeRow label="Overall size" value={size} min={50} max={150} step={5}
        onChange={setSize} hint={`${size}%`} />
      <p style={S.hint}>Scales the whole caption stack.</p>
    </Section>
  );
}

// ---- presets ------------------------------------------------------------
// Bottom-Top-Annotation-Romanization order, matching the line-cards + the
// 1-2-3-4 user model (deliberately NOT the extension's Top-first swatch strip).
const PRESET_SWATCH_LAYERS = ["Bottom", "Top", "Annotation", "Romanized"];

function presetColors(p: Preset): string[] {
  return PRESET_SWATCH_LAYERS.map((k) => p.layers[k]?.color ?? "#000000");
}

function PresetSwatches({ colors }: { colors: string[] }) {
  return (
    <span style={S.presetSwatchRow} aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} style={presetSwatchStyle(c)} />
      ))}
    </span>
  );
}

interface PresetOption {
  code: string;
  label: string;
  colors: string[];
  groupLabel?: string;
}

function buildPresetOptions(catalog: PresetCatalog | null): PresetOption[] {
  if (!catalog) return [];
  const groupKeyToLabel = new Map(catalog.groups.map((g) => [g.key, g.label] as const));
  const grouped: Record<string, Preset[]> = {};
  for (const p of catalog.presets) (grouped[p.group] ??= []).push(p);
  const out: PresetOption[] = [];
  for (const g of catalog.groups) {
    const list = grouped[g.key] ?? [];
    list.forEach((p, i) => {
      out.push({
        code: p.id,
        label: p.label,
        colors: presetColors(p),
        groupLabel: i === 0 ? (groupKeyToLabel.get(g.key) ?? g.key) : undefined,
      });
    });
  }
  return out;
}

function PresetsSection({ videoLang, ...props }: CollapseProps & { videoLang: string }) {
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [activeId, setActiveId] = useSetting("activePresetId");

  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    void fetchPresetCatalog({ lang: videoLang }).then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => { cancelled = true; };
  }, [videoLang]);

  // "Brainbow (Loom Default)" is a client-side preset injected at the top of
  // the list (the server catalog holds the language presets).
  const brainbowOption: PresetOption = {
    code: LOOMINATE_DEFAULT_PRESET_ID,
    label: LOOMINATE_DEFAULT_PRESET.label,
    colors: presetColors(LOOMINATE_DEFAULT_PRESET),
    groupLabel: "Loom",
  };
  const options = [brainbowOption, ...buildPresetOptions(catalog)];
  const current = options.find((o) => o.code === activeId) ?? null;

  const apply = (p: Preset) => {
    setActiveId(p.id);
    void applyLayerColors({
      top: p.layers.Top?.color,
      bottom: p.layers.Bottom?.color,
      annotation: p.layers.Annotation?.color,
      romanization: p.layers.Romanized?.color,
    });
  };

  return (
    <Section
      {...props}
      title="Color presets"
      summary={
        <>
          <TextSummary>{current ? current.label : "None"}</TextSummary>
          {current && <PresetSwatches colors={current.colors} />}
        </>
      }
    >
      <PresetSelect
        value={activeId}
        options={options}
        onPick={(code) => {
          const p =
            code === LOOMINATE_DEFAULT_PRESET_ID
              ? LOOMINATE_DEFAULT_PRESET
              : catalog?.presets.find((x) => x.id === code);
          if (p) apply(p);
        }}
      />
      {!catalog && <div style={S.dim}>Loading language presets…</div>}
    </Section>
  );
}

function PresetSelect({
  value,
  options,
  onPick,
}: {
  value: string;
  options: PresetOption[];
  onPick: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.code === value);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const path = e.composedPath();
      if (btnRef.current && path.includes(btnRef.current)) return;
      if (listRef.current && path.includes(listRef.current)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handle, true);
    return () => document.removeEventListener("mousedown", handle, true);
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)} style={selectButtonStyle(open)}>
        <span style={S.selectLabel}>{current ? current.label : "Choose a preset"}</span>
        {current && (
          <>
            <span style={S.presetSep}>|</span>
            <PresetSwatches colors={current.colors} />
          </>
        )}
        <span style={chevronRotStyle(open)}>▾</span>
      </button>
      {open && (
        <div ref={listRef} style={S.list} role="listbox">
          {options.map((opt) => (
            <Fragment key={opt.code}>
              {opt.groupLabel && <div style={S.presetGroupHeader}>{opt.groupLabel}</div>}
              <button
                type="button"
                onClick={() => { onPick(opt.code); setOpen(false); }}
                style={listItemStyle(value === opt.code)}
                role="option"
                aria-selected={value === opt.code}
              >
                <span style={dotStyle(value === opt.code)} />
                <span style={S.listItemLabel}>{opt.label}</span>
                <span style={S.presetSep}>|</span>
                <PresetSwatches colors={opt.colors} />
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- romanization-card controls (folded in, C-1) ------------------------
function RomanizationControls({ videoLang }: { videoLang: string }) {
  const [phonetic, setPhonetic] = useSetting("targetPhoneticSystem");
  const [longVowel, setLongVowel] = useSetting("longVowelMode");
  const systems = phoneticSystemsFor(videoLang);
  const base = videoLang.split("-")[0].toLowerCase();

  return (
    <>
      {systems.length > 1 && (
        <div style={S.subRow}>
          <span style={S.subLabel}>{phoneticSystemLabelFor(videoLang)}</span>
          <Dropdown
            value={phonetic ?? ""}
            onChange={(c) => setPhonetic(c || null)}
            options={systems.map((s) => ({ code: s.code, label: s.label }))}
            emptyLabel="Auto"
          />
        </div>
      )}
      {base === "ja" && (
        <div style={S.subRow}>
          <span style={S.subLabel}>Long vowels (romaji)</span>
          <Dropdown
            value={longVowel}
            onChange={(c) => setLongVowel(c as LongVowelMode)}
            options={LONG_VOWELS}
          />
        </div>
      )}
    </>
  );
}

// ---- per-layer line-card -------------------------------------------------
interface LineCardProps extends CollapseProps {
  title: string;
  sizeMode: "px" | "ratio";
  color: SettingName;
  alpha: SettingName;
  size: SettingName;
  font: SettingName;
  outlineColor: SettingName;
  outlineAlpha: SettingName;
  glowRadius: SettingName;
  glowColor: SettingName;
  glowAlpha: SettingName;
  enable: SettingName;
  /** behavior controls rendered under the header, above styling (C-1) */
  children?: React.ReactNode;
}

function LineCard(props: LineCardProps) {
  const [color, setColor] = useSetting(props.color) as [string, (v: string) => void];
  const [alpha, setAlpha] = useSetting(props.alpha) as [number, (v: number) => void];
  const [size, setSize] = useSetting(props.size) as [number, (v: number) => void];
  const [font, setFont] = useSetting(props.font) as [string, (v: string) => void];
  const [outlineColor, setOutlineColor] = useSetting(props.outlineColor) as [string, (v: string) => void];
  const [outlineAlpha, setOutlineAlpha] = useSetting(props.outlineAlpha) as [number, (v: number) => void];
  const [glowRadius, setGlowRadius] = useSetting(props.glowRadius) as [number, (v: number) => void];
  const [glowColor, setGlowColor] = useSetting(props.glowColor) as [string, (v: string) => void];
  const [glowAlpha, setGlowAlpha] = useSetting(props.glowAlpha) as [number, (v: number) => void];
  const [enabled, setEnabled] = useSetting(props.enable) as [boolean, (v: boolean) => void];
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const px = props.sizeMode === "px";

  return (
    <Section
      collapsed={props.collapsed}
      onToggleCollapse={props.onToggleCollapse}
      title={props.title}
      summary={<span style={colorDotStyle(color)} aria-hidden="true" />}
      trailing={<Switch on={enabled} onToggle={setEnabled} />}
    >
      {props.children}
      <ColorControl label="Color" value={color} onChange={setColor} />
      <div style={S.row}>
        <span style={S.rowLabel}>Font</span>
        <Dropdown value={font} onChange={setFont} options={fontFamilyOptions()} />
      </div>
      <div style={S.row}>
        <span style={S.rowLabel}>{px ? "Size (px)" : "Size (ratio)"}</span>
        <input
          type="number"
          value={size}
          min={px ? 12 : 0.2}
          max={px ? 120 : 1}
          step={px ? 1 : 0.05}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) setSize(v);
          }}
          style={S.numberInput}
        />
      </div>
      <RangeRow label="Opacity" value={alpha} min={0} max={100} step={1}
        onChange={setAlpha} hint={`${alpha}%`} />

      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        style={advancedToggleStyle(advancedOpen)}
        aria-expanded={advancedOpen}
      >
        Advanced {advancedOpen ? "▴" : "▾"}
      </button>
      {advancedOpen && (
        <div style={S.advancedBlock}>
          <ColorControl label="Outline color" value={outlineColor} onChange={setOutlineColor} />
          <RangeRow label="Outline opacity" value={outlineAlpha} min={0} max={100} step={1}
            onChange={setOutlineAlpha} hint={`${outlineAlpha}%`} />
          <RangeRow label="Glow radius" value={glowRadius} min={0} max={20} step={1}
            onChange={setGlowRadius} hint={glowRadius === 0 ? "none" : `${glowRadius}px`} />
          {glowRadius > 0 && (
            <>
              <ColorControl label="Glow color" value={glowColor} onChange={setGlowColor} />
              <RangeRow label="Glow opacity" value={glowAlpha} min={0} max={100} step={1}
                onChange={setGlowAlpha} hint={`${glowAlpha}%`} />
            </>
          )}
        </div>
      )}
    </Section>
  );
}

// ---- color control (swatch strip + ◐ wheel) -----------------------------
function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const [wheelOpen, setWheelOpen] = useState(false);
  return (
    <div style={S.colorOuter}>
      <div style={S.colorRow}>
        <span style={S.rowLabel}>{label}</span>
        <div style={S.swatchRow}>
          {COLOR_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              onClick={() => onChange(hex)}
              style={swatchStyle(hex, value.toLowerCase() === hex.toLowerCase())}
              aria-label={`Set color ${hex}`}
            />
          ))}
          <button
            type="button"
            onClick={() => setWheelOpen((v) => !v)}
            style={wheelTriggerStyle(wheelOpen)}
            aria-pressed={wheelOpen}
            title="Custom color"
          >
            ◐
          </button>
        </div>
      </div>
      {wheelOpen && (
        <div style={S.wheelPopover}>
          <HexColorPicker color={value} onChange={onChange} style={{ width: "100%", height: 140 }} />
          <div style={S.wheelFooter}>
            <input
              type="text"
              value={value}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
              }}
              style={S.wheelHexInput}
              spellCheck={false}
            />
            <span style={wheelSwatchStyle(value)} aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- shared rows --------------------------------------------------------
function RangeRow({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={S.rangeRow}>
      <div style={S.rangeLabelRow}>
        <span style={S.rowLabel}>{label}</span>
        {hint && <span style={S.rangeValue}>{hint}</span>}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        style={S.slider}
      />
    </div>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
  const W = 34, H = 18, DOT = 14, PAD = 2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onToggle(!on)}
      style={{
        position: "relative", flex: "0 0 auto", width: W, height: H, padding: 0,
        border: "none", borderRadius: H / 2, cursor: "pointer",
        background: on ? "#b026ff" : "#7d7048",
        boxShadow: on ? "0 0 6px rgba(176,38,255,0.55)" : "none",
        transition: "background 120ms ease, box-shadow 120ms ease",
      }}
    >
      <span style={{
        position: "absolute", top: PAD, left: on ? W - DOT - PAD : PAD,
        width: DOT, height: DOT, borderRadius: "50%", background: "#fff",
        transition: "left 120ms ease",
      }} />
    </button>
  );
}

// ---- styles (transcribed from the extension panel; mint = selection) ----
const MINT = "#5dffaa";
const S = {
  panel: {
    width: 320, background: "rgba(20,20,24,0.97)", color: "#fff",
    borderRadius: 10, padding: 12, fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: 12, lineHeight: 1.4, border: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.6)", userSelect: "none",
  },
  header: { fontSize: 13, fontWeight: 600, letterSpacing: "0.02em" },
  subheader: { fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2, marginBottom: 10 },
  section: { marginBottom: 10 },
  headerRow: { display: "flex", alignItems: "center", gap: 8, width: "100%" },
  headerTrailing: { display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto", maxWidth: "58%" },
  sectionTitle: {
    fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em",
    color: "rgba(255,255,255,0.55)", flex: "1 1 auto", minWidth: 0,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  sectionBody: {
    display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: 6,
    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
  },
  chevron: { fontSize: 9, lineHeight: 1, color: "rgba(255,255,255,0.45)", flexShrink: 0 },
  summaryText: {
    fontSize: 10, color: "rgba(255,255,255,0.55)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  rowLabel: { fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.06em" },
  subRow: { display: "flex", flexDirection: "column", gap: 4 },
  subLabel: { fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.06em" },
  rangeRow: { display: "flex", flexDirection: "column", gap: 3 },
  rangeLabelRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6 },
  rangeValue: { fontSize: 10, color: "rgba(255,255,255,0.6)", fontVariantNumeric: "tabular-nums" },
  slider: { width: "100%", accentColor: MINT, cursor: "pointer" },
  hint: { margin: "4px 0 0 0", fontSize: 10, color: "rgba(255,255,255,0.4)" },
  dim: { color: "rgba(255,255,255,0.4)", fontSize: 11 },
  numberInput: {
    width: 80, padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 12, outline: "none",
  },
  selectLabel: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  list: {
    marginTop: 4, maxHeight: 288, overflowY: "auto", background: "rgba(28,28,32,0.98)",
    borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", padding: 4,
    boxShadow: "0 6px 18px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column", gap: 1,
  },
  listItemLabel: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  trackList: { display: "flex", flexDirection: "column", gap: 2 },
  trackLabel: { flex: "1 1 auto", display: "flex", flexDirection: "column", minWidth: 0 },
  trackPrimary: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  trackSecondary: { fontSize: 10, color: "rgba(255,255,255,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  positionRow: { display: "flex", alignItems: "center", gap: 10, padding: "2px 0" },
  positionLabel: { flex: "0 0 62px", fontSize: 11, color: "rgba(255,255,255,0.75)" },
  positionButtons: { flex: "1 1 auto", display: "flex", gap: 4, flexWrap: "wrap" },
  colorOuter: { display: "flex", flexDirection: "column", gap: 4 },
  colorRow: { display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" },
  swatchRow: { display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" },
  wheelPopover: {
    display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: 6,
    background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", marginTop: 2,
  },
  wheelFooter: { display: "flex", alignItems: "center", gap: 6, paddingTop: 4 },
  wheelHexInput: {
    flex: "1 1 auto", padding: "4px 6px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)", color: "#fff", fontFamily: "monospace", fontSize: 11,
    outline: "none", letterSpacing: "0.04em",
  },
  advancedBlock: {
    display: "flex", flexDirection: "column", gap: 6, padding: "6px 0 2px",
    marginTop: 2, borderTop: "1px solid rgba(255,255,255,0.04)",
  },
  presetSwatchRow: { display: "inline-flex", alignItems: "center", gap: 3, flex: "0 0 auto" },
  presetSep: { flex: "0 0 auto", color: "rgba(255,255,255,0.25)", fontSize: 12, margin: "0 2px" },
  presetGroupHeader: {
    padding: "6px 8px 2px", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
    textTransform: "uppercase", color: "rgba(255,255,255,0.4)", userSelect: "none",
  },
} satisfies Record<string, React.CSSProperties>;

// dynamic styles
function collapsibleHeaderStyle(collapsed: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 6,
    flex: "1 1 auto", minWidth: 0, padding: 0, margin: 0, marginBottom: collapsed ? 0 : 6,
    background: "transparent", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
  };
}
function chevronRotStyle(open: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto", fontSize: 10, color: "rgba(255,255,255,0.5)",
    transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 160ms ease",
  };
}
function colorDotStyle(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: 2, background: color, border: "1px solid rgba(255,255,255,0.35)", flex: "0 0 auto" };
}
function dotStyle(sel: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto", width: 8, height: 8, borderRadius: "50%",
    background: sel ? MINT : "rgba(255,255,255,0.18)",
    boxShadow: sel ? "0 0 6px rgba(93,255,170,0.7)" : "none",
  };
}
function selectButtonStyle(open: boolean): React.CSSProperties {
  return {
    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "6px 8px", borderRadius: 6,
    border: open ? `1px solid rgba(93,255,170,0.4)` : "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 12, fontFamily: "inherit",
    outline: "none", cursor: "pointer", textAlign: "left", transition: "border-color 120ms ease",
  };
}
function listItemStyle(sel: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", minHeight: 24, borderRadius: 4,
    border: `1px solid ${sel ? "rgba(93,255,170,0.35)" : "transparent"}`,
    background: sel ? "rgba(93,255,170,0.12)" : "transparent",
    color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 12, textAlign: "left", width: "100%",
  };
}
function trackRowStyle(sel: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6,
    border: `1px solid ${sel ? "rgba(93,255,170,0.35)" : "transparent"}`,
    background: sel ? "rgba(93,255,170,0.12)" : "rgba(255,255,255,0.03)",
    color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 12, textAlign: "left", width: "100%",
  };
}
function kindBadgeStyle(kind: "manual" | "asr"): React.CSSProperties {
  return {
    flex: "0 0 auto", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em",
    padding: "2px 5px", borderRadius: 4,
    background: kind === "manual" ? "rgba(93,138,255,0.18)" : "rgba(255,180,80,0.18)",
    color: kind === "manual" ? "#9bb8ff" : "#ffc474",
    border: `1px solid ${kind === "manual" ? "rgba(93,138,255,0.35)" : "rgba(255,180,80,0.35)"}`,
  };
}
function positionButtonStyle(sel: boolean): React.CSSProperties {
  return {
    flex: "1 1 0", minWidth: 48, padding: "5px 6px", borderRadius: 4,
    border: sel ? "1px solid rgba(93,255,170,0.45)" : "1px solid rgba(255,255,255,0.12)",
    background: sel ? "rgba(93,255,170,0.15)" : "rgba(255,255,255,0.04)",
    color: sel ? MINT : "#fff", fontSize: 11, fontFamily: "inherit", fontWeight: 500,
    cursor: "pointer", textAlign: "center",
  };
}
function advancedToggleStyle(open: boolean): React.CSSProperties {
  return {
    marginTop: 2, padding: "5px 8px", borderRadius: 4,
    border: open ? "1px solid rgba(93,138,255,0.35)" : "1px solid rgba(255,255,255,0.08)",
    background: open ? "rgba(93,138,255,0.12)" : "rgba(255,255,255,0.02)",
    color: open ? "#9bb8ff" : "rgba(255,255,255,0.55)", fontFamily: "inherit", fontSize: 10,
    fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
    width: "fit-content", alignSelf: "flex-end",
  };
}
function swatchStyle(hex: string, sel: boolean): React.CSSProperties {
  return {
    width: 18, height: 18, borderRadius: "50%",
    border: sel ? "2px solid rgba(255,255,255,0.95)" : "1px solid rgba(255,255,255,0.2)",
    background: hex, cursor: "pointer", padding: 0,
    boxShadow: sel ? "0 0 0 2px rgba(0,0,0,0.4)" : "none",
  };
}
function wheelTriggerStyle(open: boolean): React.CSSProperties {
  return {
    width: 22, height: 22, borderRadius: "50%",
    border: open ? "2px solid rgba(93,255,170,0.9)" : "1px solid rgba(255,255,255,0.25)",
    background: "conic-gradient(from 0deg, #ff5c5c, #ffe05c, #5cff9e, #5cffff, #9b8aff, #ff5c9e, #ff5c5c)",
    cursor: "pointer", padding: 0, fontSize: 0,
    boxShadow: open ? "0 0 0 2px rgba(93,255,170,0.3)" : "0 0 0 1px rgba(0,0,0,0.4)",
    transition: "box-shadow 120ms ease, border-color 120ms ease",
  };
}
function wheelSwatchStyle(hex: string): React.CSSProperties {
  return { width: 20, height: 20, borderRadius: 4, border: "1px solid rgba(255,255,255,0.25)", background: hex, flex: "0 0 auto" };
}
function presetSwatchStyle(color: string): React.CSSProperties {
  return { width: 12, height: 12, borderRadius: 3, background: color, border: "1px solid rgba(255,255,255,0.35)", boxSizing: "border-box", flex: "0 0 auto" };
}
