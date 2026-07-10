import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";

import { useCaptionStream } from "./caption-context";
import type { CaptionPosition } from "./caption-context";
import {
  LOOMINATE_DEFAULT_PRESET,
  LOOMINATE_DEFAULT_PRESET_ID,
} from "./caption-context";
import {
  classifyLang,
  phoneticSystemsFor,
  phoneticSystemLabelFor,
  sameBaseLang,
  type LangSupport,
} from "@/lib/captions/lang-support";
import type { CaptionTrack } from "@/lib/captions/types";
import { getPlatform } from "@/lib/captions/platform";
import {
  resolveOrthographyVariants,
  type VariantDescriptor,
} from "@loom/orthography-tables";
import type { Preset, PresetCatalog } from "@/lib/presets/types";
import { getPillAnchor } from "@/lib/overlay/pill-position";
import { swallowPlayerEvents } from "@/lib/overlay/stop-player-events";
import {
  getCorpusConsent,
  resolveCaptureEnabled,
  setCorpusConsent,
  type CorpusConsent,
} from "@/lib/corpus/consent";
import { IS_DEV } from "@/lib/env";
import { t, languageName } from "@/lib/i18n";
import { getDefineCapabilities } from "@/lib/annotate/capabilities";
import { glossLangsForSource, isDefinable } from "@/lib/annotate/define-lang";

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
//   - Your language          Base BCP-47 code auto-pick uses to find
//                            the Bottom layer source.  Persisted.
//   - Video language (Top)   Source-track radio list + translate dropdown.
//   - Your language (Bottom) Source-track radio list + translate dropdown.
//   (User-facing labels are de-jargoned: "Target"→"Video language",
//    "Native"→"Your language"; code identifiers stay target/native.)
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
const SUPPORTED_LANG_CODES: string[] = [
  "ar",
  "be",
  "bn",
  "bg",
  "yue",
  "ca",
  "zh-Hans",
  "zh-Hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "fil",
  "fi",
  "fr",
  "gl",
  "de",
  "gu",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "mn",
  "no",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sw",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
];

/** Build the language-picker options at render time.  Codes + ordering
    are fixed (SUPPORTED_LANG_CODES); the human-readable names come from
    Intl.DisplayNames via languageName() in the active UI locale, so the
    49-entry list never needs hand-translation. */
function supportedLangs(): LangOption[] {
  return SUPPORTED_LANG_CODES.map((code) => ({
    code,
    label: languageName(code),
  }));
}

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

// Built at render time (labels via t()) — see the timing note on
// FONT_FAMILY / LONG_VOWEL options below.
function positionOptions(): Array<{ code: CaptionPosition; label: string }> {
  return [
    { code: "top-1", label: t("settings.pos.top1") },
    { code: "top-2", label: t("settings.pos.top2") },
    { code: "bottom-1", label: t("settings.pos.bot1") },
    { code: "bottom-2", label: t("settings.pos.bot2") },
  ];
}

// Webkit/Firefox custom scrollbar styling for LangSelect popovers.
// Injected once via <style> inside the shadow root.  The .scrolling
// class is toggled by JS on scroll events (800ms idle debounce) so the
// scrollbar fades in while the user scrolls and fades out when idle.
// :hover provides a fallback for mouse-only interaction.
//
// Firefox uses scrollbar-color / scrollbar-width.  No native transition
// support in Firefox for those properties — the class toggle produces
// an instant cut rather than a fade.  Acceptable degradation.
// react-colorful's runtime style injection puts a <style> in
// document.head, but our shadow root doesn't inherit it.  Inline the
// CSS here so it lives inside the shadow tree along with our own
// scoped styles.  Pinned from node_modules/react-colorful 5.6.1 —
// re-extract when bumping the dep (see scripts/extract-colorful-css.sh
// if it ever feels worth automating).  +1 override: width 100% so the
// wheel fills our popover container instead of the library's 200px.
const REACT_COLORFUL_CSS = ".react-colorful{position:relative;display:flex;flex-direction:column;width:200px;height:200px;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;cursor:default}.react-colorful__saturation{position:relative;flex-grow:1;border-color:transparent;border-bottom:12px solid #000;border-radius:8px 8px 0 0;background-image:linear-gradient(0deg,#000,transparent),linear-gradient(90deg,#fff,hsla(0,0%,100%,0))}.react-colorful__alpha-gradient,.react-colorful__pointer-fill{content:\"\";position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;border-radius:inherit}.react-colorful__alpha-gradient,.react-colorful__saturation{box-shadow:inset 0 0 0 1px rgba(0,0,0,.05)}.react-colorful__alpha,.react-colorful__hue{position:relative;height:24px}.react-colorful__hue{background:linear-gradient(90deg,red 0,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,red)}.react-colorful__last-control{border-radius:0 0 8px 8px}.react-colorful__interactive{position:absolute;left:0;top:0;right:0;bottom:0;border-radius:inherit;outline:none;touch-action:none}.react-colorful__pointer{position:absolute;z-index:1;box-sizing:border-box;width:28px;height:28px;transform:translate(-50%,-50%);background-color:#fff;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,.2)}.react-colorful__interactive:focus .react-colorful__pointer{transform:translate(-50%,-50%) scale(1.1)}.react-colorful__alpha,.react-colorful__alpha-pointer{background-color:#fff;background-image:url('data:image/svg+xml;charset=utf-8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" fill-opacity=\".05\"><path d=\"M8 0h8v8H8zM0 8h8v8H0z\"/></svg>')}.react-colorful__saturation-pointer{z-index:3}.react-colorful__hue-pointer{z-index:2}.react-colorful{width:100%;height:160px}.react-colorful__pointer{width:18px;height:18px}";

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

// Build label for the panel footer — also a quiet dev/prod tell
// ("Loom (Dev) v0.1.0" vs "Loom v0.1.0").  Constant per session.
const BUILD_INFO: string = (() => {
  try {
    const m = browser.runtime.getManifest();
    return `${m.name ?? "Loom"} v${m.version}`;
  } catch {
    return "Loom";
  }
})();

// Donations page on the companion web app (☕ "Support Loom" link at the top
// of the panel). Hardcoded rather than derived from API_BASE_URL — the web app
// lives on a different host (loom.* vs api.loom.*) and only the prod web app
// has the page.
const SUPPORT_URL = "https://loom.nerv-analytic.ai/donate";

// ---- Collapsible-section persistence --------------------------------
// Open/closed state for the top-level sections.  GLOBAL, not per-platform — a
// layout preference should read the same everywhere; the per-platform bits are
// the section VALUES (size, position), never their collapse state.  Persisted
// to storage.local so it survives reloads and carries across platforms.  New
// installs (and any unknown id) default to COLLAPSED.
const COLLAPSE_STORAGE_KEY = "loom_collapsed_sections";
const COLLAPSIBLE_SECTION_IDS = [
  "native",
  "target-track",
  "native-track",
  "position",
  "size",
  "presets",
  "bottom-style",
  "top-style",
  "annotation-style",
  "romanization-style",
  "dictionary",
  "data",
] as const;

function allSectionsCollapsed(): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const id of COLLAPSIBLE_SECTION_IDS) m[id] = true;
  return m;
}

// Module-level cache, warmed at import so the panel opens without an
// expand→collapse flash (the content script loads well before the pill click).
// null = not yet read from storage.
let cachedCollapsed: Record<string, boolean> | null = null;

function readCollapsedFromStorage(): Promise<Record<string, boolean>> {
  try {
    return browser.storage.local
      .get(COLLAPSE_STORAGE_KEY)
      .then((r) => {
        const stored = r?.[COLLAPSE_STORAGE_KEY];
        const merged =
          stored && typeof stored === "object"
            ? { ...allSectionsCollapsed(), ...(stored as Record<string, boolean>) }
            : allSectionsCollapsed();
        cachedCollapsed = merged;
        return merged;
      })
      .catch(() => {
        cachedCollapsed = allSectionsCollapsed();
        return cachedCollapsed;
      });
  } catch {
    cachedCollapsed = allSectionsCollapsed();
    return Promise.resolve(cachedCollapsed);
  }
}
void readCollapsedFromStorage();

function persistCollapsed(next: Record<string, boolean>): void {
  cachedCollapsed = next;
  try {
    void browser.storage.local.set({ [COLLAPSE_STORAGE_KEY]: next });
  } catch {
    /* storage unavailable — in-memory state still updates for this session */
  }
}

export function SettingsPanel({
  open,
  onClose,
  pillRef,
  onDeactivate,
}: SettingsPanelProps) {
  const {
    status,
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
    annotationColor,
    topFontFamily,
    bottomFontFamily,
    annotationFontFamily,
    topFontSizePx,
    bottomFontSizePx,
    captionSizePct,
    topPositionOffsetPct,
    bottomPositionOffsetPct,
    lineSpacingPx,
    annotationFontRatio,
    targetPosition,
    nativePosition,
    targetAnnotateEnabled,
    nativeAnnotateEnabled,
    targetPhoneticSystem,
    nativePhoneticSystem,
    targetVariantEnabled,
    nativeVariantEnabled,
    variantHighlightEnabled,
    variantColor,
    variantCleanColor,
    variantCollapseColor,
    presetCatalog,
    activePresetId,
    applyPreset,
    topAlpha,
    bottomAlpha,
    annotationAlpha,
    romanizationAlpha,
    topGroupOpacityLinked,
    topLineEnabled,
    bottomLineEnabled,
    topOutlineColor,
    bottomOutlineColor,
    annotationOutlineColor,
    topOutlineAlpha,
    bottomOutlineAlpha,
    annotationOutlineAlpha,
    topGlowRadius,
    bottomGlowRadius,
    annotationGlowRadius,
    topGlowColor,
    bottomGlowColor,
    annotationGlowColor,
    topGlowAlpha,
    bottomGlowAlpha,
    annotationGlowAlpha,
    setTopAlpha,
    setBottomAlpha,
    setAnnotationAlpha,
    setRomanizationAlpha,
    setTopGroupOpacityLinked,
    setTopLineEnabled,
    setBottomLineEnabled,
    setTopOutlineColor,
    setBottomOutlineColor,
    setAnnotationOutlineColor,
    setTopOutlineAlpha,
    setBottomOutlineAlpha,
    setAnnotationOutlineAlpha,
    setTopGlowRadius,
    setBottomGlowRadius,
    setAnnotationGlowRadius,
    setTopGlowColor,
    setBottomGlowColor,
    setAnnotationGlowColor,
    setTopGlowAlpha,
    setBottomGlowAlpha,
    setAnnotationGlowAlpha,
    setTargetTrack,
    setNativeTrack,
    setTargetTranslateTo,
    setNativeTranslateTo,
    setNativeLangPref,
    setTopColor,
    setBottomColor,
    setAnnotationColor,
    setTopFontFamily,
    setBottomFontFamily,
    setAnnotationFontFamily,
    setTopFontSizePx,
    setBottomFontSizePx,
    setCaptionSizePct,
    setTopPositionOffsetPct,
    setBottomPositionOffsetPct,
    setLineSpacingPx,
    setAnnotationFontRatio,
    setTargetPosition,
    setNativePosition,
    setTargetAnnotateEnabled,
    setNativeAnnotateEnabled,
    setTargetPhoneticSystem,
    setNativePhoneticSystem,
    targetRomanizeEnabled,
    nativeRomanizeEnabled,
    longVowelMode,
    romanizationColor,
    romanizationFontFamily,
    romanizationFontRatio,
    setTargetRomanizeEnabled,
    setNativeRomanizeEnabled,
    setLongVowelMode,
    dictionaryGlossLang,
    setDictionaryGlossLang,
    setRomanizationColor,
    setRomanizationFontFamily,
    setRomanizationFontRatio,
    setTargetVariantEnabled,
    setNativeVariantEnabled,
    setVariantHighlightEnabled,
    setVariantColor,
    setVariantCleanColor,
    setVariantCollapseColor,
    variantColorSameAsTop,
    setVariantColorSameAsTop,
  } = useCaptionStream();

  const panelRef = useRef<HTMLDivElement | null>(null);

  // Collapsible-section state.  Seeded from the module cache (warmed at import)
  // so it opens without a flash; falls back to all-collapsed.  Persisted to
  // storage.local (global) so the layout survives reloads and matches across
  // platforms.  Keyed by a stable section id; absent/unknown id = COLLAPSED.
  const [collapsedSections, setCollapsedSections] = useState<
    Record<string, boolean>
  >(() => cachedCollapsed ?? allSectionsCollapsed());
  // If the cache wasn't warm yet at first mount, hydrate once from storage.
  useEffect(() => {
    if (cachedCollapsed) return;
    let alive = true;
    void readCollapsedFromStorage().then((m) => {
      if (alive) setCollapsedSections(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  const section = (id: string) => ({
    collapsed: collapsedSections[id] ?? true,
    onToggleCollapse: () =>
      setCollapsedSections((c) => {
        const next = { ...c, [id]: !(c[id] ?? true) };
        persistCollapsed(next);
        return next;
      }),
  });

  // Corpus-contribution consent (CORPUS_WIRING.md §1e) — read/written
  // straight through lib/corpus/consent (not caption-context: it's an
  // account-level preference, not per-page caption state).  undefined =
  // storage read pending; the row renders once known.
  const [corpusConsent, setCorpusConsentState] = useState<
    CorpusConsent | undefined
  >(undefined);
  useEffect(() => {
    let cancelled = false;
    getCorpusConsent()
      .then((c) => {
        if (!cancelled) setCorpusConsentState(c);
      })
      .catch(() => {
        if (!cancelled) setCorpusConsentState(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const handleCorpusToggle = (v: boolean) => {
    setCorpusConsentState(v);
    void setCorpusConsent(v).catch((e) =>
      console.warn("[Loom] failed to persist corpus consent:", e),
    );
  };

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

  // Platform-aware UI (5h-5).  Netflix has no machine-translation
  // equivalent (each track is its own signed WebVTT URL) and no
  // manual/ASR track distinction — both are YouTube concepts.  A null
  // platform (shouldn't happen while the panel is open) defaults to the
  // YouTube-like surface so nothing is hidden by accident.
  const platform = getPlatform();
  const supportsTranslate = platform?.supportsTranslate ?? true;
  // Human-readable platform name for user-facing copy (e.g. the "no
  // auto-translation" hint) — keeps strings from hardcoding one platform.
  const platformName =
    platform?.id === "youtube"
      ? "YouTube"
      : platform?.id === "netflix"
        ? "Netflix"
        : platform?.id === "iqiyi"
          ? "iQIYI"
          : platform?.id === "wetv"
            ? "WeTV"
            : "this platform";
  // ASR/manual badges are meaningful only on YouTube — Netflix, iQIYI and
  // WeTV tracks are all author-provided (never speech-recognised).
  const showKindBadges = platform?.id === "youtube";
  const emptyTracksHint =
    status.kind === "unsupported"
      ? platform?.id === "netflix" && status.reason === "no-captions"
        ? t("settings.empty.imageSubs")
        : t("settings.empty.noTracks")
      : t("settings.empty.discovering");

  // ---- Collapsed-section summaries -----------------------------------
  // Each collapsible passes one of these as `summary`; CollapsibleHeader shows
  // it (right-aligned) only while collapsed, so the item's key state reads at a
  // glance without expanding.  Line-cards + Data pass a live Switch so the most
  // common toggles stay one-click; the rest are informational text/swatches.
  const posArrow = (p: CaptionPosition): string =>
    p.startsWith("top") ? "↑" : "↓";
  const currentPreset =
    activePresetId === LOOMINATE_DEFAULT_PRESET_ID
      ? LOOMINATE_DEFAULT_PRESET
      : (presetCatalog?.presets.find((p) => p.id === activePresetId) ?? null);
  const presetSwatchActive = [
    topLineEnabled,
    bottomLineEnabled,
    topLineEnabled && targetAnnotateEnabled,
    topLineEnabled && targetRomanizeEnabled,
  ];
  const textSummary = (s: string): React.ReactNode => (
    <span style={collapsedSummaryTextStyle()}>{s}</span>
  );
  const lineSummary = (
    color: string,
    on: boolean,
    onToggle: (v: boolean) => void,
    aria: string,
  ): React.ReactNode => (
    <>
      <span style={summaryColorDotStyle(color)} aria-hidden="true" />
      <Switch on={on} onToggle={onToggle} ariaLabel={aria} />
    </>
  );

  return (
    <div ref={panelRef} style={panelStyle()} {...swallowPlayerEvents}>
      {/* Scoped scrollbar styling for nested LangSelect lists.  Lives
          inside the shadow root via this <style> element; no external
          stylesheet. */}
      <style>{SCROLLBAR_CSS}</style>
      {/* react-colorful's runtime auto-inject targets document.head,
          which our shadow tree doesn't inherit.  Inline the CSS so the
          color wheel actually has shape + colors. */}
      <style>{REACT_COLORFUL_CSS}</style>

      <a
        href={SUPPORT_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={supportLinkStyle()}
      >
        <span aria-hidden="true">☕</span>
        <span>{t("settings.support")}</span>
      </a>

      <div style={headerStyle()}>
        <span>{t("settings.title")}</span>
        <button
          type="button"
          onClick={onClose}
          style={closeButtonStyle()}
          aria-label={t("settings.close")}
        >
          ×
        </button>
      </div>

      <Section
        title={t("settings.userLang.title")}
        {...section("native")}
        summary={textSummary(languageName(nativeLangPref))}
      >
        <LangSelect
          value={nativeLangPref}
          onChange={(code) => setNativeLangPref(code)}
          options={supportedLangs()}
        />
        <p style={hintStyle()}>{t("settings.userLang.hint")}</p>
      </Section>

      <LayerSection
        title={t("settings.videoLang.title", { count: tracks.length })}
        tracks={tracks}
        selected={selectedTarget}
        isUserPicked={isUserPickedTarget}
        onPickTrack={setTargetTrack}
        translateTo={targetTranslateTo}
        onPickTranslateTo={setTargetTranslateTo}
        allowNullTrack={false}
        showTranslate={supportsTranslate}
        showBadges={showKindBadges}
        emptyHint={emptyTracksHint}
        {...section("target-track")}
        summary={textSummary(
          selectedTarget ? languageName(selectedTarget.languageCode) : "—",
        )}
      />

      <LayerSection
        title={t("settings.bottomLang.title")}
        tracks={tracks}
        selected={selectedNative}
        isUserPicked={isUserPickedNative}
        onPickTrack={setNativeTrack}
        translateTo={nativeTranslateTo}
        onPickTranslateTo={setNativeTranslateTo}
        allowNullTrack
        nullLabel={
          supportsTranslate
            ? t("settings.bottomLang.autoTranslate", { lang: nativeLangPref })
            : t("settings.bottomLang.noAutoTranslate", { platform: platformName })
        }
        showTranslate={supportsTranslate}
        showBadges={showKindBadges}
        emptyHint={emptyTracksHint}
        {...section("native-track")}
        summary={textSummary(
          selectedNative
            ? languageName(selectedNative.languageCode)
            : nativeTranslateTo
              ? `→ ${languageName(nativeTranslateTo)}`
              : "—",
        )}
      />

      <Section
        title={t("settings.position.title")}
        {...section("position")}
        summary={
          <>
            <span style={summaryColorDotStyle(topColor)} aria-hidden="true" />
            <span style={collapsedSummaryTextStyle()}>
              {posArrow(targetPosition)}
            </span>
            <span style={summaryColorDotStyle(bottomColor)} aria-hidden="true" />
            <span style={collapsedSummaryTextStyle()}>
              {posArrow(nativePosition)}
            </span>
          </>
        }
      >
        <PositionRow
          label={t("settings.videoLang")}
          value={targetPosition}
          onChange={setTargetPosition}
        />
        <PositionRow
          label={t("settings.userLang")}
          value={nativePosition}
          onChange={setNativePosition}
        />
        <p style={hintStyle()}>{t("settings.position.hint")}</p>
        <RangeRow
          label={t("settings.position.topNudge")}
          value={topPositionOffsetPct}
          min={-40}
          max={40}
          step={1}
          onChange={setTopPositionOffsetPct}
          hint={`${topPositionOffsetPct > 0 ? "+" : ""}${topPositionOffsetPct}%`}
        />
        <RangeRow
          label={t("settings.position.bottomNudge")}
          value={bottomPositionOffsetPct}
          min={-40}
          max={40}
          step={1}
          onChange={setBottomPositionOffsetPct}
          hint={`${bottomPositionOffsetPct > 0 ? "+" : ""}${bottomPositionOffsetPct}%`}
        />
        <RangeRow
          label={t("settings.position.lineSpacing")}
          value={lineSpacingPx}
          min={0}
          max={40}
          step={1}
          onChange={setLineSpacingPx}
          hint={`${lineSpacingPx}px`}
        />
        <p style={hintStyle()}>{t("settings.position.nudgeHint")}</p>
      </Section>

      <Section
        title={t("settings.size.title")}
        {...section("size")}
        summary={textSummary(`${captionSizePct}%`)}
      >
        <RangeRow
          label={t("settings.size.overall")}
          value={captionSizePct}
          min={50}
          max={150}
          step={5}
          onChange={setCaptionSizePct}
          hint={`${captionSizePct}%`}
        />
        <p style={hintStyle()}>{t("settings.size.hint")}</p>
      </Section>

      {/* ---- The four line-cards (C-1) ----------------------------
          Each box owns ALL of one line's controls: its enable toggles,
          phonetic-system / alt-orth options, AND its styling.  Presets
          sit above since they paint across the lines at once. */}
      <Section
        title={t("settings.presets.title")}
        {...section("presets")}
        summary={
          <>
            <span style={collapsedSummaryTextStyle()}>
              {currentPreset ? currentPreset.label : t("settings.preset.noPreset")}
            </span>
            {currentPreset && (
              <PresetSwatches
                colors={presetColors(currentPreset)}
                active={presetSwatchActive}
              />
            )}
          </>
        }
      >
        <PresetPicker
          catalog={presetCatalog}
          activeId={activePresetId}
          onApply={applyPreset}
          swatchActive={[
            topLineEnabled,
            bottomLineEnabled,
            topLineEnabled && targetAnnotateEnabled,
            topLineEnabled && targetRomanizeEnabled,
          ]}
        />
      </Section>

      {/* Bottom — native text */}
      <LayerStyleBlock
        label={t("settings.layer.bottom")}
        {...section("bottom-style")}
        summary={lineSummary(
          bottomColor,
          bottomLineEnabled,
          setBottomLineEnabled,
          t("settings.layer.showBottom"),
        )}
        color={bottomColor}
        onColorChange={setBottomColor}
        fontFamily={bottomFontFamily}
        onFontFamilyChange={setBottomFontFamily}
        sizeMode="px"
        sizeValue={bottomFontSizePx}
        onSizeChange={setBottomFontSizePx}
        opacity={{ value: bottomAlpha, onChange: setBottomAlpha }}
        advanced={{
          alpha: bottomAlpha,
          onAlphaChange: setBottomAlpha,
          outlineColor: bottomOutlineColor,
          onOutlineColorChange: setBottomOutlineColor,
          outlineAlpha: bottomOutlineAlpha,
          onOutlineAlphaChange: setBottomOutlineAlpha,
          glowRadius: bottomGlowRadius,
          onGlowRadiusChange: setBottomGlowRadius,
          glowColor: bottomGlowColor,
          onGlowColorChange: setBottomGlowColor,
          glowAlpha: bottomGlowAlpha,
          onGlowAlphaChange: setBottomGlowAlpha,
        }}
      >
        <ToggleRow
          label={t("settings.layer.showBottom")}
          value={bottomLineEnabled}
          onChange={setBottomLineEnabled}
        />
      </LayerStyleBlock>

      {/* Top — foreign text + its alternate-orthography ruby */}
      <LayerStyleBlock
        label={t("settings.layer.top")}
        {...section("top-style")}
        summary={lineSummary(
          topColor,
          topLineEnabled,
          setTopLineEnabled,
          t("settings.layer.showTop"),
        )}
        color={topColor}
        onColorChange={setTopColor}
        fontFamily={topFontFamily}
        onFontFamilyChange={setTopFontFamily}
        sizeMode="px"
        sizeValue={topFontSizePx}
        onSizeChange={setTopFontSizePx}
        opacity={{ value: topAlpha, onChange: setTopAlpha }}
        advancedExtra={
          <div style={layerStyleRowStyle()}>
            <div style={variantInlineLabelRowStyle()}>
              <span style={layerStyleRowLabelStyle()}>
                {t("settings.layer.linkOpacity")}
              </span>
              <Switch
                on={topGroupOpacityLinked}
                onToggle={setTopGroupOpacityLinked}
                ariaLabel={t("settings.layer.linkOpacityAria")}
              />
            </div>
          </div>
        }
        advanced={{
          alpha: topAlpha,
          onAlphaChange: setTopAlpha,
          outlineColor: topOutlineColor,
          onOutlineColorChange: setTopOutlineColor,
          outlineAlpha: topOutlineAlpha,
          onOutlineAlphaChange: setTopOutlineAlpha,
          glowRadius: topGlowRadius,
          onGlowRadiusChange: setTopGlowRadius,
          glowColor: topGlowColor,
          onGlowColorChange: setTopGlowColor,
          glowAlpha: topGlowAlpha,
          onGlowAlphaChange: setTopGlowAlpha,
        }}
      >
        <ToggleRow
          label={t("settings.layer.showTop")}
          value={topLineEnabled}
          onChange={setTopLineEnabled}
        />
        <VariantSection
          selectedTarget={selectedTarget}
          selectedNative={selectedNative}
          targetEnabled={targetVariantEnabled}
          nativeEnabled={nativeVariantEnabled}
          highlightEnabled={variantHighlightEnabled}
          variantColor={variantColor}
          cleanColor={variantCleanColor}
          collapseColor={variantCollapseColor}
          variantColorSameAsTop={variantColorSameAsTop}
          topColor={topColor}
          onTargetToggle={setTargetVariantEnabled}
          onNativeToggle={setNativeVariantEnabled}
          onHighlightToggle={setVariantHighlightEnabled}
          onVariantColorChange={setVariantColor}
          onCleanColorChange={setVariantCleanColor}
          onCollapseColorChange={setVariantCollapseColor}
          onVariantColorSameAsTopToggle={setVariantColorSameAsTop}
        />
      </LayerStyleBlock>

      {/* Annotation — per-token readings above the foreign text */}
      <LayerStyleBlock
        label={t("settings.annotation.label")}
        {...section("annotation-style")}
        summary={lineSummary(
          annotationColor,
          targetAnnotateEnabled,
          setTargetAnnotateEnabled,
          t("settings.annotation.label"),
        )}
        color={annotationColor}
        onColorChange={setAnnotationColor}
        fontFamily={annotationFontFamily}
        onFontFamilyChange={setAnnotationFontFamily}
        sizeMode="ratio"
        sizeValue={annotationFontRatio}
        onSizeChange={setAnnotationFontRatio}
        opacity={{
          value: annotationAlpha,
          onChange: setAnnotationAlpha,
          show: !topGroupOpacityLinked,
        }}
        advanced={{
          alpha: annotationAlpha,
          onAlphaChange: setAnnotationAlpha,
          outlineColor: annotationOutlineColor,
          onOutlineColorChange: setAnnotationOutlineColor,
          outlineAlpha: annotationOutlineAlpha,
          onOutlineAlphaChange: setAnnotationOutlineAlpha,
          glowRadius: annotationGlowRadius,
          onGlowRadiusChange: setAnnotationGlowRadius,
          glowColor: annotationGlowColor,
          onGlowColorChange: setAnnotationGlowColor,
          glowAlpha: annotationGlowAlpha,
          onGlowAlphaChange: setAnnotationGlowAlpha,
        }}
      >
        <AnnotateRow
          label={t("settings.videoLang")}
          track={selectedTarget}
          enabled={targetAnnotateEnabled}
          onToggle={setTargetAnnotateEnabled}
        />
        <AdvancedDisclosure label={t("settings.annotation.userLangAdvanced")}>
          <AnnotateRow
            label={t("settings.userLang")}
            track={selectedNative}
            enabled={nativeAnnotateEnabled}
            onToggle={setNativeAnnotateEnabled}
          />
        </AdvancedDisclosure>
        <p style={hintStyle()}>{t("settings.annotation.hint")}</p>
      </LayerStyleBlock>

      {/* Romanization — full-utterance phonetic line */}
      <LayerStyleBlock
        label={t("settings.romanization.label")}
        {...section("romanization-style")}
        summary={lineSummary(
          romanizationColor,
          targetRomanizeEnabled,
          setTargetRomanizeEnabled,
          t("settings.romanization.label"),
        )}
        color={romanizationColor}
        onColorChange={setRomanizationColor}
        fontFamily={romanizationFontFamily}
        onFontFamilyChange={setRomanizationFontFamily}
        sizeMode="ratio"
        sizeValue={romanizationFontRatio}
        onSizeChange={setRomanizationFontRatio}
        opacity={{
          value: romanizationAlpha,
          onChange: setRomanizationAlpha,
          show: !topGroupOpacityLinked,
        }}
        // Advanced outline / glow inherits from the parent line it sits
        // above — a separate advanced surface is a follow-up if asked.
        advanced={null}
      >
        <RomanizeRow
          label={t("settings.videoLang")}
          track={selectedTarget}
          enabled={targetRomanizeEnabled}
          onToggle={setTargetRomanizeEnabled}
        />
        <PhoneticSystemRow
          track={selectedTarget}
          value={targetPhoneticSystem}
          onChange={setTargetPhoneticSystem}
        />
        {[selectedTarget, selectedNative].some(
          (t) => !!t && sameBaseLang(t.languageCode, "ja"),
        ) && (
          <JapaneseLongVowelRow
            mode={longVowelMode}
            onPickMode={setLongVowelMode}
          />
        )}
        <AdvancedDisclosure label={t("settings.romanization.userLangAdvanced")}>
          <RomanizeRow
            label={t("settings.userLang")}
            track={selectedNative}
            enabled={nativeRomanizeEnabled}
            onToggle={setNativeRomanizeEnabled}
          />
          <PhoneticSystemRow
            track={selectedNative}
            value={nativePhoneticSystem}
            onChange={setNativePhoneticSystem}
          />
        </AdvancedDisclosure>
        <p style={hintStyle()}>{t("settings.romanization.hint")}</p>
      </LayerStyleBlock>

      <DictionaryLanguageSection
        track={selectedTarget}
        glossLang={dictionaryGlossLang}
        onChange={setDictionaryGlossLang}
        sectionProps={section("dictionary")}
      />

      <Section
        title={t("settings.data.title")}
        {...section("data")}
        summary={
          corpusConsent !== undefined ? (
            <Switch
              on={resolveCaptureEnabled(corpusConsent, IS_DEV)}
              onToggle={handleCorpusToggle}
              ariaLabel={t("settings.data.contribute")}
            />
          ) : undefined
        }
      >
        {corpusConsent !== undefined && (
          <ToggleRow
            label={t("settings.data.contribute")}
            value={resolveCaptureEnabled(corpusConsent, IS_DEV)}
            onChange={handleCorpusToggle}
          />
        )}
        <p style={hintStyle()}>{t("settings.data.hint")}</p>
      </Section>

      <div style={deactivateRowStyle()}>
        <button
          type="button"
          onClick={onDeactivate}
          style={deactivateButtonStyle()}
        >
          {t("settings.turnOff")}
        </button>
        <p style={hintStyle()}>{t("settings.turnOff.hint")}</p>
      </div>

      <div style={footerStyle()}>
        <span>{BUILD_INFO}</span>
        <a
          href="https://github.com/Beyond-InFinnity/Loom/issues"
          target="_blank"
          rel="noopener noreferrer"
          style={footerLinkStyle()}
        >
          {t("settings.feedback")}
        </a>
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
  /** Show the "Translate to" picker.  Off where the platform has no
      machine translation (Netflix). */
  showTranslate: boolean;
  /** Show the manual/ASR kind badge on tracks (YouTube-only). */
  showBadges: boolean;
  /** Message shown when no tracks are available — platform + status
      aware (e.g. image-only Netflix titles vs still-discovering). */
  emptyHint: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  summary?: React.ReactNode;
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
  showTranslate,
  showBadges,
  emptyHint,
  collapsed,
  onToggleCollapse,
  summary,
}: LayerSectionProps) {
  return (
    <Section
      title={title}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      summary={summary}
    >
      {tracks.length === 0 ? (
        <p style={hintStyle()}>{emptyHint}</p>
      ) : (
        <>
          <TrackList
            tracks={tracks}
            selected={selected}
            isUserPicked={isUserPicked}
            onPick={onPickTrack}
            allowNull={allowNullTrack}
            nullLabel={nullLabel}
            showBadges={showBadges}
          />
          {showTranslate && (
            <div style={translateRowStyle()}>
              <label style={translateLabelStyle()}>
                {t("settings.translateTo")}
              </label>
              <LangSelect
                value={translateTo ?? ""}
                onChange={(code) =>
                  onPickTranslateTo(code === "" ? null : code)
                }
                options={supportedLangs()}
                emptyOption={{ label: t("settings.noTranslation") }}
              />
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---- Sub-components -------------------------------------------------

interface SectionProps {
  title: string;
  children: React.ReactNode;
  /** Collapsible behavior.  When `onToggleCollapse` is provided the title
      becomes a clickable header (with a chevron) and the body is hidden
      while `collapsed`.  Omit both for a static, always-open section. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** One-line summary shown in the header while collapsed (see
      CollapsibleHeader.trailing) — the item's key state at a glance. */
  summary?: React.ReactNode;
}

/** "Dictionary language" line — picks the gloss language per-word definitions
    are written in.  Renders ONLY when the current video (Top) track is definable
    AND its source language offers more than one gloss language (else there's
    nothing to choose).  Auto = follow the browser UI language.  Mirrors the
    picker inside the definition card via the shared global override. */
function DictionaryLanguageSection({
  track,
  glossLang,
  onChange,
  sectionProps,
}: {
  track: CaptionTrack | null;
  glossLang: string | null;
  onChange: (code: string | null) => void;
  sectionProps: { collapsed: boolean; onToggleCollapse: () => void };
}) {
  const [options, setOptions] = useState<string[]>([]);
  const sourceLang = track?.languageCode ?? null;
  useEffect(() => {
    let cancelled = false;
    getDefineCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setOptions(
          isDefinable(caps, sourceLang)
            ? glossLangsForSource(caps, sourceLang)
            : [],
        );
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceLang]);

  // Nothing to pick from → no line (keeps the panel quiet for single-gloss or
  // non-definable languages).
  if (options.length <= 1) return null;
  const value = glossLang ?? "";
  return (
    <Section
      title={t("define.glossLanguage")}
      {...sectionProps}
      summary={
        <span style={collapsedSummaryTextStyle()}>
          {value ? languageName(value) : t("define.glossAuto")}
        </span>
      }
    >
      <div style={dictLangRowStyle()}>
        <select
          value={value}
          onChange={(e) => onChange(e.currentTarget.value || null)}
          style={dictLangSelectStyle()}
        >
          <option value="">{t("define.glossAuto")}</option>
          {options.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </select>
      </div>
    </Section>
  );
}

function Section({
  title,
  children,
  collapsed = false,
  onToggleCollapse,
  summary,
}: SectionProps) {
  return (
    <div style={sectionStyle()}>
      {onToggleCollapse ? (
        <CollapsibleHeader
          title={title}
          collapsed={collapsed}
          onToggle={onToggleCollapse}
          titleStyle={sectionTitleStyle()}
          trailing={summary}
        />
      ) : (
        <div style={sectionTitleStyle()}>{title}</div>
      )}
      {!collapsed && children}
    </div>
  );
}

/** Shared clickable section header: a full-width transparent button that
    shows the section title (in its native style) plus a chevron that
    points down when open and right when collapsed.  Used by both Section
    and LayerStyleBlock so every collapsible reads identically. */
function CollapsibleHeader({
  title,
  collapsed,
  onToggle,
  titleStyle,
  trailing,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  titleStyle: React.CSSProperties;
  /** Shown to the right of the header ONLY while collapsed — a one-line
      summary or an interactive control (e.g. a line's on/off Switch).  It sits
      OUTSIDE the toggle button, so interactive controls don't nest in it and
      their clicks don't toggle the collapse. */
  trailing?: React.ReactNode;
}) {
  return (
    <div style={collapsibleHeaderRowStyle()}>
      <button
        type="button"
        onClick={onToggle}
        style={collapsibleHeaderStyle(collapsed)}
        aria-expanded={!collapsed}
      >
        <span style={collapseChevronStyle()} aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span
          style={{
            ...titleStyle,
            marginBottom: 0,
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
      </button>
      {collapsed && trailing != null && (
        <div style={collapsibleHeaderTrailingStyle()}>{trailing}</div>
      )}
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
  /** Show the manual/ASR kind badge.  YouTube-only concept; off for
      Netflix (every track is "manual" there, so the badge is noise). */
  showBadges?: boolean;
}

function TrackList({
  tracks,
  selected,
  isUserPicked,
  onPick,
  allowNull = false,
  nullLabel,
  showBadges = true,
}: TrackListProps) {
  return (
    <div style={trackListStyle()}>
      {allowNull && (
        <TrackRow
          isSelected={selected === null}
          isAuto={!isUserPicked && selected === null}
          onClick={() => onPick(null)}
          primary={nullLabel ?? t("settings.track.auto")}
          secondary=""
          badge={null}
        />
      )}
      {tracks.map((track) => {
        // Identity is the track id, NOT languageCode — a video can carry
        // several tracks per language (plain "English" vs "English (CC)"),
        // and matching on languageCode highlighted them all as selected.
        const isSelected = selected !== null && selected.id === track.id;
        const classification = classifyLang(track.languageCode);
        return (
          <TrackRow
            key={track.id}
            isSelected={isSelected}
            isAuto={!isUserPicked && isSelected}
            onClick={() => onPick(track)}
            primary={track.name}
            secondary={`${track.languageCode} · ${describeProcessing(classification)}`}
            badge={showBadges ? (track.kind === "asr" ? "asr" : "manual") : null}
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
  if (c.family === "hangul") return "Korean Roman";
  if (c.family === "cyrillic") return "Cyrillic translit";
  if (c.family === "thai") return "Thai translit";
  if (c.family === "hebrew") return "Hebrew translit";
  if (c.family === "arabic") return "Arabic translit";
  if (c.family === "indic") return "Indic Roman (IAST)";
  if (c.processing === "native-display") return t("settings.proc.latinNone");
  return t("settings.proc.none");
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
      {isAuto && <span style={autoBadgeStyle()}>{t("settings.badge.auto")}</span>}
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
  const [wheelOpen, setWheelOpen] = useState(false);
  return (
    <div style={colorRowOuterStyle()}>
      <div style={colorRowStyle()}>
        {label && <span style={colorLabelStyle()}>{label}</span>}
        <div style={swatchRowStyle()}>
          {COLOR_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              onClick={() => onChange(hex)}
              style={swatchStyle(hex, value.toLowerCase() === hex.toLowerCase())}
              aria-label={t("settings.setColor", { hex })}
            />
          ))}
          <button
            type="button"
            onClick={() => setWheelOpen((v) => !v)}
            style={wheelTriggerStyle(wheelOpen, value)}
            aria-label={t("settings.colorWheel")}
            aria-pressed={wheelOpen}
            title={t("settings.colorWheel")}
          >
            ◐
          </button>
        </div>
      </div>
      {wheelOpen && (
        <div style={wheelPopoverStyle()}>
          <HexColorPicker color={value} onChange={onChange} />
          <div style={wheelFooterStyle()}>
            <input
              type="text"
              value={value}
              onChange={(e) => {
                const v = e.target.value.trim();
                // Only commit valid 6-digit hex; let the user keep
                // typing intermediates without resetting state.
                if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
              }}
              style={wheelHexInputStyle()}
              spellCheck={false}
            />
            <span style={wheelSwatchStyle(value)} aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- LayerStyleBlock ------------------------------------------------
//
// Self-contained styling controls for one caption layer (Bottom, Top,
// or Annotation).  Mirrors the desktop's per-layer style sections.
// Three rows: color (swatches + custom input), font family (the
// scrollable LangSelect dropdown reused as a generic option picker),
// font size (number input).  Annotation uses sizeMode="ratio" — the
// size is expressed as a fraction of the Top layer's size, matching
// loom_core/styles.py::annotation_font_ratio convention.

/** Font options offered in every layer's family dropdown.  "auto" =
    the cross-script Noto-fallback stack (the same one the overlay
    has always used).  The rest are well-known faces that ship with
    most modern OSes OR are common enough that even when absent the
    browser's fallback chain produces something legible.  CSS values
    are full font-family strings so they're applied verbatim. */
// Built at render time — t() must never run at module top level (it runs
// before initUiLocale()).  Only the two generic labels are keyed; the
// Noto/OS font family names are proper nouns kept verbatim.
function fontFamilyOptions(): Array<{ code: string; label: string }> {
  return [
    { code: "auto", label: t("settings.font.auto") },
    { code: "'Noto Sans JP', sans-serif", label: "Noto Sans JP" },
    { code: "'Noto Sans SC', sans-serif", label: "Noto Sans SC (Simplified)" },
    { code: "'Noto Sans TC', sans-serif", label: "Noto Sans TC (Traditional)" },
    { code: "'Noto Sans KR', sans-serif", label: "Noto Sans KR" },
    { code: "'Noto Sans Thai', sans-serif", label: "Noto Sans Thai" },
    { code: "'Noto Serif JP', serif", label: "Noto Serif JP" },
    { code: "'Noto Serif', serif", label: "Noto Serif" },
    { code: "sans-serif", label: t("settings.font.systemSans") },
    { code: "serif", label: "System serif" },
    { code: "monospace", label: "System monospace" },
    { code: "Arial, sans-serif", label: "Arial" },
    { code: "Helvetica, sans-serif", label: "Helvetica" },
    { code: "Georgia, serif", label: "Georgia" },
    { code: "'Times New Roman', serif", label: "Times New Roman" },
    { code: "'Courier New', monospace", label: "Courier New" },
  ];
}

interface LayerStyleBlockProps {
  label: string;
  color: string;
  onColorChange: (hex: string) => void;
  fontFamily: string;
  onFontFamilyChange: (family: string) => void;
  /** "px" = absolute pixel size at 1080p reference; "ratio" =
      fraction of the Top layer's size (only used for Annotation). */
  sizeMode: "px" | "ratio";
  sizeValue: number;
  onSizeChange: (value: number) => void;
  /** Advanced controls — bundled together so they can be opt-in via
      one "Advanced ▾" toggle.  Pass null to hide the advanced section
      entirely for layers that don't have these fields wired (today
      all three of Bottom/Top/Annotation have them; future romanized
      layer in 5e will too). */
  advanced: {
    alpha: number;
    onAlphaChange: (value: number) => void;
    outlineColor: string;
    onOutlineColorChange: (hex: string) => void;
    outlineAlpha: number;
    onOutlineAlphaChange: (value: number) => void;
    glowRadius: number;
    onGlowRadiusChange: (value: number) => void;
    glowColor: string;
    onGlowColorChange: (hex: string) => void;
    glowAlpha: number;
    onGlowAlphaChange: (value: number) => void;
  } | null;
  /** Per-line behavior controls (toggles, phonetic-system, alt-orth…)
      rendered directly under the card header, above the styling rows —
      so each line owns ALL its controls in one box (C-1). */
  children?: React.ReactNode;
  /** First-class opacity slider (C-5).  `show:false` hides it (e.g. an
      Annotation/Romanization line whose opacity is currently linked to
      the Top group). */
  opacity?: {
    value: number;
    onChange: (v: number) => void;
    show?: boolean;
  };
  /** Extra controls rendered at the TOP of the Advanced block — e.g. the
      Top card's "link opacity" toggle. */
  advancedExtra?: React.ReactNode;
  /** Collapsible behavior (same contract as Section): when
      `onToggleCollapse` is supplied the card header is clickable and the
      whole body hides while `collapsed`. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** One-line summary (usually the line's on/off Switch) shown in the header
      while collapsed. */
  summary?: React.ReactNode;
}

function LayerStyleBlock({
  label,
  color,
  onColorChange,
  fontFamily,
  onFontFamilyChange,
  sizeMode,
  sizeValue,
  onSizeChange,
  advanced,
  children,
  opacity,
  advancedExtra,
  collapsed = false,
  onToggleCollapse,
  summary,
}: LayerStyleBlockProps) {
  const sizeLabel =
    sizeMode === "px" ? t("settings.sizePx") : t("settings.sizeRatio");
  const sizeMin = sizeMode === "px" ? 12 : 0.2;
  const sizeMax = sizeMode === "px" ? 120 : 1.0;
  const sizeStep = sizeMode === "px" ? 1 : 0.05;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  return (
    <div style={layerStyleBlockStyle()}>
      {onToggleCollapse ? (
        <CollapsibleHeader
          title={label}
          collapsed={collapsed}
          onToggle={onToggleCollapse}
          titleStyle={layerStyleHeaderStyle()}
          trailing={summary}
        />
      ) : (
        <div style={layerStyleHeaderStyle()}>{label}</div>
      )}
      {collapsed ? null : (
        <>
      {children}
      <div style={layerStyleRowStyle()}>
        <span style={layerStyleRowLabelStyle()}>{t("settings.color")}</span>
        <ColorRow label="" value={color} onChange={onColorChange} />
      </div>
      <div style={layerStyleRowStyle()}>
        <span style={layerStyleRowLabelStyle()}>{t("settings.font")}</span>
        <LangSelect
          value={fontFamily}
          onChange={(code) => onFontFamilyChange(code)}
          options={fontFamilyOptions()}
        />
      </div>
      <div style={layerStyleRowStyle()}>
        <span style={layerStyleRowLabelStyle()}>{sizeLabel}</span>
        <input
          type="number"
          value={sizeValue}
          min={sizeMin}
          max={sizeMax}
          step={sizeStep}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onSizeChange(v);
          }}
          style={numberInputStyle()}
        />
      </div>
      {opacity && (opacity.show ?? true) && (
        <PercentSliderRow
          label={t("settings.opacity")}
          value={opacity.value}
          onChange={opacity.onChange}
        />
      )}
      {(advanced || advancedExtra) && (
        <>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            style={advancedToggleStyle(advancedOpen)}
            aria-expanded={advancedOpen}
          >
            {t("settings.advanced")} {advancedOpen ? "▴" : "▾"}
          </button>
          {advancedOpen && (
            <div style={advancedBlockStyle()}>
              {advancedExtra}
              {advanced && (
                <>
              <div style={layerStyleRowStyle()}>
                <span style={layerStyleRowLabelStyle()}>{t("settings.outlineColor")}</span>
                <ColorRow
                  label=""
                  value={advanced.outlineColor}
                  onChange={advanced.onOutlineColorChange}
                />
              </div>
              <PercentSliderRow
                label={t("settings.outlineAlpha")}
                value={advanced.outlineAlpha}
                onChange={advanced.onOutlineAlphaChange}
              />
              <RangeRow
                label={t("settings.glowRadius")}
                value={advanced.glowRadius}
                min={0}
                max={20}
                step={1}
                onChange={advanced.onGlowRadiusChange}
                hint={
                  advanced.glowRadius === 0
                    ? t("settings.glowNone")
                    : t("settings.glowHalo", { n: advanced.glowRadius })
                }
              />
              {advanced.glowRadius > 0 && (
                <>
                  <div style={layerStyleRowStyle()}>
                    <span style={layerStyleRowLabelStyle()}>{t("settings.glowColor")}</span>
                    <ColorRow
                      label=""
                      value={advanced.glowColor}
                      onChange={advanced.onGlowColorChange}
                    />
                  </div>
                  <PercentSliderRow
                    label={t("settings.glowAlpha")}
                    value={advanced.glowAlpha}
                    onChange={advanced.onGlowAlphaChange}
                  />
                </>
              )}
                </>
              )}
            </div>
          )}
        </>
      )}
        </>
      )}
    </div>
  );
}

// ---- Numeric input rows --------------------------------------------

interface PercentSliderRowProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
}

function PercentSliderRow({ label, value, onChange }: PercentSliderRowProps) {
  return (
    <div style={layerStyleRowStyle()}>
      <div style={percentLabelRowStyle()}>
        <span style={layerStyleRowLabelStyle()}>{label}</span>
        <span style={percentValueStyle()}>{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!Number.isNaN(v)) onChange(v);
        }}
        style={sliderStyle()}
      />
    </div>
  );
}

interface RangeRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: RangeRowProps) {
  return (
    <div style={layerStyleRowStyle()}>
      <div style={percentLabelRowStyle()}>
        <span style={layerStyleRowLabelStyle()}>{label}</span>
        {hint && <span style={percentValueStyle()}>{hint}</span>}
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
        style={sliderStyle()}
      />
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
        {positionOptions().map((opt) => (
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

// ---- Switch — dot-in-pill on/off toggle -----------------------------
//
// Replaces the old "ON / OFF" text buttons (C-4).  A track with a dot
// that sits left when off, right when on: desaturated greyed-gold off,
// neon purple on.  Pure CSS transition (no backdrop-filter — see the
// Tripwires note: this renders over the continuously-repainting player).
// role="switch" + aria-checked for a11y; the caller owns the label.
function Switch({
  on,
  onToggle,
  ariaLabel,
}: {
  on: boolean;
  onToggle: (v: boolean) => void;
  ariaLabel?: string;
}) {
  const TRACK_W = 34;
  const TRACK_H = 18;
  const DOT = 14;
  const PAD = 2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onToggle(!on)}
      style={{
        position: "relative",
        flex: "0 0 auto",
        width: `${TRACK_W}px`,
        height: `${TRACK_H}px`,
        padding: 0,
        border: "none",
        borderRadius: `${TRACK_H / 2}px`,
        cursor: "pointer",
        // off: desaturated greyed-gold · on: neon purple
        background: on ? "#b026ff" : "#7d7048",
        boxShadow: on ? "0 0 6px rgba(176, 38, 255, 0.55)" : "none",
        transition: "background 120ms ease, box-shadow 120ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: `${PAD}px`,
          left: on ? `${TRACK_W - DOT - PAD}px` : `${PAD}px`,
          width: `${DOT}px`,
          height: `${DOT}px`,
          borderRadius: "50%",
          background: "#ffffff",
          transition: "left 120ms ease",
        }}
      />
    </button>
  );
}

// ---- ToggleRow — labelled switch row inside a line-card -------------
// Used for the per-line master enable (C-8).
function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={layerStyleRowStyle()}>
      <div style={variantInlineLabelRowStyle()}>
        <span style={layerStyleRowLabelStyle()}>{label}</span>
        <Switch on={value} onToggle={onChange} ariaLabel={label} />
      </div>
    </div>
  );
}

// ---- AdvancedDisclosure — collapsible "Advanced ▾" sub-block --------
//
// Reuses the per-layer Advanced toggle styling for an in-section
// disclosure (e.g. tucking the Native/Bottom annotation toggle away as
// an edge case — accessible, but out of the primary flow; C-4).
function AdvancedDisclosure({
  children,
  label = t("settings.advanced"),
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={advancedToggleStyle(open)}
        aria-expanded={open}
      >
        {label} {open ? "▴" : "▾"}
      </button>
      {open && <div style={advancedBlockStyle()}>{children}</div>}
    </>
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
}

function AnnotateRow({ label, track, enabled, onToggle }: AnnotateRowProps) {
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
        <Switch on={enabled} onToggle={onToggle} ariaLabel={`${label} toggle`} />
      </div>
      {!annotatable && (
        <p style={hintStyle()}>
          {track
            ? t("settings.annotate.none")
            : t("settings.chooseTrack")}
        </p>
      )}
    </div>
  );
}

// ---- PhoneticSystemRow (capability-driven, I-1 / C-2) ---------------
//
// `phonetic_system` governs the romanization LINE for every multi-system
// language (and, for CJK, the ruby too) — so the picker is driven by the
// track's actual capability via phoneticSystemsFor(), NOT bolted to the
// annotation row.  Renders nothing for single-system langs (Korean,
// Cyrillic, Indic, Hebrew, Japanese) where there's no choice to make.
interface PhoneticSystemRowProps {
  track: CaptionTrack | null;
  value: string | null;
  onChange: (code: string | null) => void;
}

function PhoneticSystemRow({ track, value, onChange }: PhoneticSystemRowProps) {
  const systems = track ? phoneticSystemsFor(track.languageCode) : [];
  if (systems.length < 2) return null;
  const systemLabel = track
    ? phoneticSystemLabelFor(track.languageCode)
    : t("settings.romanize.style");
  return (
    <div style={annotateSystemRowStyle()}>
      <span style={annotateSystemLabelStyle()}>{systemLabel}</span>
      <LangSelect
        value={value ?? ""}
        onChange={(code) => onChange(code === "" ? null : code)}
        options={systems}
        emptyOption={{ label: t("settings.romanize.auto") }}
      />
    </div>
  );
}

// ---- RomanizeRow (5e) ---------------------------------------------
//
// Per-layer toggle for the full-utterance romanization line.
// Eligibility: any language whose classifier puts it in either
// "annotate-romanize" (CJK + Korean — gets ruby AND the line) or
// "romanize" (Cyrillic / Thai / Indic / Hebrew / Arabic-Persian-Urdu
// — the line IS the phonetic surface).  Latin-script and unsupported
// langs dim the row + explain why.

interface RomanizeRowProps {
  label: string;
  track: CaptionTrack | null;
  enabled: boolean;
  onToggle: (v: boolean) => void;
}

function RomanizeRow({ label, track, enabled, onToggle }: RomanizeRowProps) {
  const cls = track ? classifyLang(track.languageCode) : null;
  const romanizable =
    cls?.processing === "annotate-romanize" || cls?.processing === "romanize";
  const dim = !romanizable;

  return (
    <div style={annotateRowStyle(dim)}>
      <div style={annotateHeaderStyle()}>
        <span style={annotateLabelStyle()}>{label}</span>
        <Switch on={enabled} onToggle={onToggle} ariaLabel={`${label} toggle`} />
      </div>
      {!romanizable && (
        <p style={hintStyle()}>
          {track
            ? t("settings.romanize.none")
            : t("settings.chooseTrack")}
        </p>
      )}
    </div>
  );
}

// ---- JapaneseLongVowelRow (5e) ------------------------------------
//
// Global setting (not per-layer) because if both layers happen to be
// Japanese they'd share the same long-vowel convention anyway.  Only
// surfaces meaningfully on Japanese tracks; harmless on everything
// else (backend ignores it for non-ja langs).

// Built at render time (labels via t()) — see the FONT_FAMILY note above.
function longVowelOptions(): Array<{
  code: "macrons" | "doubled" | "unmarked";
  label: string;
}> {
  return [
    { code: "macrons", label: t("settings.longVowel.macrons") },
    { code: "doubled", label: t("settings.longVowel.doubled") },
    { code: "unmarked", label: t("settings.longVowel.unmarked") },
  ];
}

function JapaneseLongVowelRow({
  mode,
  onPickMode,
}: {
  mode: "macrons" | "doubled" | "unmarked";
  onPickMode: (m: "macrons" | "doubled" | "unmarked") => void;
}) {
  return (
    <div style={annotateSystemRowStyle()}>
      <span style={annotateSystemLabelStyle()}>{t("settings.longVowel.label")}</span>
      <LangSelect
        value={mode}
        onChange={(code) => {
          if (code === "macrons" || code === "doubled" || code === "unmarked") {
            onPickMode(code);
          }
        }}
        options={longVowelOptions()}
      />
    </div>
  );
}

// ---- VariantSection — alternate-orthography ruby ------------------
//
// Capability-gated (C-2): the section renders only when a selected
// track has a registered orthography variant (today: the Traditional-
// Chinese family → Simplified).  On any other video it returns null —
// language-specific controls appear only for the language they apply to.
//
// Data-driven: per-layer toggle state resolves via
// @loom/orthography-tables.  A layer whose track has no variant dims its
// row + explains why, but the section as a whole stays hidden unless at
// least one side qualifies.
//
// Shared controls (highlight + colours) appear only when at least
// one layer is actually enabled — no point exposing color pickers
// for a feature that has nothing to paint yet.

interface VariantSectionProps {
  selectedTarget: CaptionTrack | null;
  selectedNative: CaptionTrack | null;
  targetEnabled: boolean;
  nativeEnabled: boolean;
  highlightEnabled: boolean;
  variantColor: string;
  cleanColor: string;
  collapseColor: string;
  /** When true, the Simplified-char swatch is locked to the Top color. */
  variantColorSameAsTop: boolean;
  /** Top layer color — shown as the effective Simplified-char color while
      "same as Top" is checked. */
  topColor: string;
  onTargetToggle: (v: boolean) => void;
  onNativeToggle: (v: boolean) => void;
  onHighlightToggle: (v: boolean) => void;
  onVariantColorChange: (hex: string) => void;
  onCleanColorChange: (hex: string) => void;
  onCollapseColorChange: (hex: string) => void;
  onVariantColorSameAsTopToggle: (v: boolean) => void;
}

function VariantSection({
  selectedTarget,
  selectedNative,
  targetEnabled,
  nativeEnabled,
  highlightEnabled,
  variantColor,
  cleanColor,
  collapseColor,
  variantColorSameAsTop,
  topColor,
  onTargetToggle,
  onNativeToggle,
  onHighlightToggle,
  onVariantColorChange,
  onCleanColorChange,
  onCollapseColorChange,
  onVariantColorSameAsTopToggle,
}: VariantSectionProps) {
  const targetVariant = selectedTarget
    ? resolveOrthographyVariants(selectedTarget.languageCode)[0] ?? null
    : null;
  const nativeVariant = selectedNative
    ? resolveOrthographyVariants(selectedNative.languageCode)[0] ?? null
    : null;

  // Capability-gated (C-2): the whole section is hidden unless a
  // selected track actually has an orthography variant (today: only the
  // Traditional-Chinese family).  No more always-mounted dimmed rows on
  // every video — the feature surfaces exactly when it applies.
  if (!targetVariant && !nativeVariant) return null;

  // Effective-enabled: a toggle only counts when its track ALSO has a
  // variant.  Stops a stale "on" toggle from claiming the feature is
  // active when the user has since switched to a non-Chinese track.
  const targetEffective = targetEnabled && !!targetVariant;
  const nativeEffective = nativeEnabled && !!nativeVariant;
  const anyEnabled = targetEffective || nativeEffective;
  // The Simplified glyph tracks the Top color while "same as Top" is on
  // (the live overlay resolves the same way in caption-overlay).
  const effectiveVariantColor = variantColorSameAsTop ? topColor : variantColor;

  return (
    <Section title={t("settings.variant.title")}>
      <VariantToggleRow
        label={t("settings.videoLang")}
        track={selectedTarget}
        variant={targetVariant}
        enabled={targetEnabled}
        onToggle={onTargetToggle}
      />
      <VariantToggleRow
        label={t("settings.userLang")}
        track={selectedNative}
        variant={nativeVariant}
        enabled={nativeEnabled}
        onToggle={onNativeToggle}
      />
      {anyEnabled && (
        <div style={layerStyleBlockStyle()}>
          <div style={layerStyleHeaderStyle()}>
            {t("settings.variant.highlightColors")}
          </div>

          <VariantPreview
            variantColor={effectiveVariantColor}
            cleanColor={cleanColor}
            collapseColor={collapseColor}
            highlightEnabled={highlightEnabled}
          />

          <div style={layerStyleRowStyle()}>
            <div style={variantInlineLabelRowStyle()}>
              <span style={layerStyleRowLabelStyle()}>
                {t("settings.variant.colorCode")}
              </span>
              <Switch
                on={highlightEnabled}
                onToggle={onHighlightToggle}
                ariaLabel={t("settings.variant.colorCode")}
              />
            </div>
          </div>

          <div style={layerStyleRowStyle()}>
            <div style={variantInlineLabelRowStyle()}>
              <span style={layerStyleRowLabelStyle()}>
                {t("settings.variant.simpSameAsTop")}
              </span>
              <Switch
                on={variantColorSameAsTop}
                onToggle={onVariantColorSameAsTopToggle}
                ariaLabel="Simplified char same as Top"
              />
            </div>
          </div>

          <div style={layerStyleRowStyle()}>
            <span style={layerStyleRowLabelStyle()}>{t("settings.variant.simpColor")}</span>
            {variantColorSameAsTop ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: 0.7,
                  fontSize: 11,
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    background: topColor,
                    border: "1px solid rgba(255,255,255,0.3)",
                  }}
                />
                {t("settings.variant.matchesTop")}
              </span>
            ) : (
              <ColorRow
                label=""
                value={variantColor}
                onChange={onVariantColorChange}
              />
            )}
          </div>

          {highlightEnabled && (
            <>
              <div style={layerStyleRowStyle()}>
                <span style={layerStyleRowLabelStyle()}>
                  {t("settings.variant.distinctColor")}
                </span>
                <ColorRow label="" value={cleanColor} onChange={onCleanColorChange} />
              </div>
              <div style={layerStyleRowStyle()}>
                <span style={layerStyleRowLabelStyle()}>
                  {t("settings.variant.mergedColor")}
                </span>
                <ColorRow
                  label=""
                  value={collapseColor}
                  onChange={onCollapseColorChange}
                />
              </div>
            </>
          )}

          <p style={hintStyle()}>
            <strong style={variantHintStrongStyle()}>
              {t("settings.variant.distinct")}:
            </strong>{" "}
            {t("settings.variant.distinctHint")}
            <br />
            <strong style={variantHintStrongStyle()}>
              {t("settings.variant.merged")}:
            </strong>{" "}
            {t("settings.variant.mergedHint")}
          </p>
        </div>
      )}
    </Section>
  );
}

// ---- VariantPreview — inline live demo --------------------------
//
// Tiny ruby render showing the user EXACTLY what their color choices
// produce.  Two examples, each labeled with its case so the cyan-vs-
// amber color choice maps unambiguously to a concept.  Examples:
//   - "Distinct"  → 語 → 语 (clean 1:1; no other trad char → 语)
//   - "Merged"    → 髮 → 发 (forward-collapse; 髮 AND 發 both → 发)
//                   Right side surfaces the "+ 發" remainder so the
//                   user can see the merging visually, not just hear
//                   about it in the hint.

interface VariantPreviewProps {
  variantColor: string;
  cleanColor: string;
  collapseColor: string;
  highlightEnabled: boolean;
}

function VariantPreview({
  variantColor,
  cleanColor,
  collapseColor,
  highlightEnabled,
}: VariantPreviewProps) {
  return (
    <div style={variantPreviewStyle()}>
      <span style={variantPreviewLabelStyle()}>{t("settings.variant.preview")}</span>
      <div style={variantPreviewContentStyle()}>
        <div style={variantPreviewColumnStyle()}>
          <span style={variantPreviewCaseLabelStyle()}>{t("settings.variant.distinct")}</span>
          <ruby>
            <span style={{ color: highlightEnabled ? cleanColor : "#fff" }}>
              語
            </span>
            <rt
              style={{
                fontSize: "11px",
                color: variantColor,
                rubyPosition: "under",
                transform: "translateY(2px)",
              }}
            >
              语
            </rt>
          </ruby>
        </div>
        <div style={variantPreviewColumnStyle()}>
          <span style={variantPreviewCaseLabelStyle()}>{t("settings.variant.merged")}</span>
          <div style={variantPreviewMergeRowStyle()}>
            <ruby>
              <span style={{ color: highlightEnabled ? collapseColor : "#fff" }}>
                髮
              </span>
              <rt
                style={{
                  fontSize: "11px",
                  color: variantColor,
                  rubyPosition: "under",
                  transform: "translateY(2px)",
                }}
              >
                发
              </rt>
            </ruby>
            <span style={variantPreviewPlusStyle()}>+</span>
            <span
              style={{
                color: highlightEnabled ? collapseColor : "#fff",
              }}
            >
              發
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface VariantToggleRowProps {
  label: string;
  track: CaptionTrack | null;
  /** Resolved variant for this track's language, or null when no
   *  variant applies (e.g. English, Japanese, Simplified Chinese). */
  variant: VariantDescriptor | null;
  enabled: boolean;
  onToggle: (v: boolean) => void;
}

function VariantToggleRow({
  label,
  track,
  variant,
  enabled,
  onToggle,
}: VariantToggleRowProps) {
  // Dim when there's no resolvable variant for this track — same
  // visual convention AnnotateRow uses for non-annotatable langs.
  // Toggle stays interactive so the user can flip it ahead of
  // switching to a track that DOES support it.
  const dim = !variant;
  const labelText = variant
    ? `${label}: show ${variant.targetLabel} above`
    : `${label}: alternate orthography`;
  return (
    <div style={annotateRowStyle(dim)}>
      <div style={annotateHeaderStyle()}>
        <span style={annotateLabelStyle()}>{labelText}</span>
        <Switch on={enabled} onToggle={onToggle} ariaLabel={`${label} toggle`} />
      </div>
      {variant ? (
        <p style={hintStyle()}>
          Reading aid for {variant.sourceHint}: each character that
          differs in {variant.targetHint} floats a small auxiliary ruby
          of the {variant.targetLabel} form above the reading.
        </p>
      ) : (
        <p style={hintStyle()}>
          {track
            ? `${track.languageCode}: ${t("settings.variant.none")}`
            : t("settings.chooseTrack")}
        </p>
      )}
    </div>
  );
}

// ---- PresetPicker — thematic color preset dropdown ------------------
//
// Mirrors the desktop's /styles/presets UI: a grouped list of named
// presets (Classic / Cultural / Dark / Adaptive) that, when picked,
// writes the Bottom / Top / Annotation color state atomically.
//
// Languages: the catalog returned by the API is ALREADY lang-filtered
// (we pass selectedTarget.languageCode when fetching), so a zh-Hant
// track sees "Blue-and-White Porcelain" and a ja track sees "NERV
// Command"/"Ukiyo-e"/etc. without us doing client-side filtering.
//
// "(Custom)" sentinel item — pickable explicitly to clear the active
// preset id without changing any colors; useful when the user has
// been hand-editing colors and wants to drop the preset attribution.

interface PresetPickerProps {
  catalog: PresetCatalog | null;
  activeId: string;
  onApply: (preset: Preset) => void;
  /** Which swatch positions (Top, Bottom, Annotation, Romanized — in that
      order) are actually rendered in the current setup.  Inactive positions
      still show their preset color, dimmed, so the whole scheme previews. */
  swatchActive: boolean[];
}

function PresetPicker({
  catalog,
  activeId,
  onApply,
  swatchActive,
}: PresetPickerProps) {
  const items = buildPresetOptions(catalog);

  function pick(code: string): void {
    if (code === LOOMINATE_DEFAULT_PRESET_ID) {
      onApply(LOOMINATE_DEFAULT_PRESET); // re-pick = reset colors to default
      return;
    }
    const preset = catalog?.presets.find((p) => p.id === code);
    if (preset) onApply(preset);
  }

  if (!catalog) {
    return (
      <div style={presetPickerWrapperStyle()}>
        <span style={layerStyleRowLabelStyle()}>{t("settings.preset.label")}</span>
        <div style={presetPickerPlaceholderStyle()}>{t("settings.preset.loading")}</div>
      </div>
    );
  }

  return (
    <div style={presetPickerWrapperStyle()}>
      <div style={presetPickerHeaderStyle()}>
        <span style={layerStyleRowLabelStyle()}>{t("settings.preset.label")}</span>
      </div>
      <PresetSelect
        value={activeId}
        onChange={pick}
        options={items}
        swatchActive={swatchActive}
        emptyLabel={t("settings.preset.noPreset")}
      />
      {catalog.presets.length === 0 && (
        <div style={presetPickerPlaceholderStyle()}>{t("settings.preset.none")}</div>
      )}
    </div>
  );
}

// A preset row: clean display name + the scheme's colors in layer order
// (Top, Bottom, Annotation, Romanized).  `groupLabel` marks the first row of a
// catalog group so the list can print a section header above it.
interface PresetOption {
  code: string;
  label: string;
  colors: string[];
  groupLabel?: string;
}

// Swatch order = primary first.  Top is the video/foreign line (the main
// learning content), then the native Bottom, then the two reading aids.
const PRESET_SWATCH_LAYERS = ["Top", "Bottom", "Annotation", "Romanized"];

function presetColors(p: Preset): string[] {
  return PRESET_SWATCH_LAYERS.map((k) => p.layers[k]?.color ?? "#000000");
}

/** A color swatch strip — one square per preset layer, in PRESET_SWATCH_LAYERS
    order.  A position that isn't shown in the current setup renders its own
    color dimmed (a greyed-out version of that hue, never neutral grey), so the
    whole scheme is previewable without applying it. */
function PresetSwatches({
  colors,
  active,
}: {
  colors: string[];
  active: boolean[];
}) {
  return (
    <span style={presetSwatchesRowStyle()} aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} style={presetSwatchStyle(c, active[i] ?? false)} />
      ))}
    </span>
  );
}

/** Preset dropdown with per-row color previews.  Dedicated (not LangSelect) so
    each row can render "name | swatches" and NO internal id/variable code. */
function PresetSelect({
  value,
  onChange,
  options,
  swatchActive,
  emptyLabel,
}: {
  value: string;
  onChange: (code: string) => void;
  options: PresetOption[];
  swatchActive: boolean[];
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.code === value);

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
        <span style={selectButtonLabelStyle()}>
          {current ? current.label : emptyLabel}
        </span>
        {current && (
          <>
            <span style={presetSepStyle()}>|</span>
            <PresetSwatches colors={current.colors} active={swatchActive} />
          </>
        )}
        <span style={chevronStyle(open)}>▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          className="loom-langselect-list"
          style={listStyle()}
          role="listbox"
        >
          {options.map((opt) => (
            <Fragment key={opt.code}>
              {opt.groupLabel && (
                <div style={presetGroupHeaderStyle()}>{opt.groupLabel}</div>
              )}
              <button
                type="button"
                onClick={() => pick(opt.code)}
                style={langSelectItemStyle(value === opt.code)}
                role="option"
                aria-selected={value === opt.code}
              >
                <span style={trackRowDotStyle(value === opt.code)} />
                <span style={langSelectItemLabelStyle()}>{opt.label}</span>
                <span style={presetSepStyle()}>|</span>
                <PresetSwatches colors={opt.colors} active={swatchActive} />
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** Flatten the catalog's groups into preset rows: clean display name + the
 *  scheme's colors, with each group's first row tagged so the list prints a
 *  section header above it.  No internal id/variable code is ever surfaced. */
function buildPresetOptions(catalog: PresetCatalog | null): PresetOption[] {
  // The Loom default preset is client-side (not from /styles/presets) and
  // ALWAYS leads the list — even while the catalog is still loading or a
  // track has no language-themed presets, "Brainbow (Loom Default)" is pickable.
  const out: PresetOption[] = [
    {
      code: LOOMINATE_DEFAULT_PRESET_ID,
      label: LOOMINATE_DEFAULT_PRESET.label,
      colors: presetColors(LOOMINATE_DEFAULT_PRESET),
    },
  ];
  if (!catalog) return out;
  const groupKeyToLabel = new Map(
    catalog.groups.map((g) => [g.key, g.label] as const),
  );
  // Sort presets into stable group order, then by index within group.
  const groupOrder = catalog.groups.map((g) => g.key);
  const grouped: Record<string, Preset[]> = {};
  for (const p of catalog.presets) {
    (grouped[p.group] ??= []).push(p);
  }
  for (const groupKey of groupOrder) {
    const list = grouped[groupKey] ?? [];
    if (list.length === 0) continue;
    const groupLabel = groupKeyToLabel.get(groupKey) ?? groupKey;
    list.forEach((p, i) => {
      out.push({
        code: p.id,
        label: p.label,
        colors: presetColors(p),
        groupLabel: i === 0 ? groupLabel : undefined,
      });
    });
  }
  return out;
}

// ---- Styles ---------------------------------------------------------

function panelStyle(): React.CSSProperties {
  // Anchor the panel just below the pill.  Pill height ≈ 36px, so the
  // panel top tracks the pill's top + 36 (platform-resolved — Netflix
  // drops the pill below its report flag, and the panel follows).
  const anchor = getPillAnchor();
  const panelTop = anchor.top + 36;
  return {
    position: "absolute",
    top: `${panelTop}px`,
    right: `${anchor.right}px`,
    width: "320px",
    // The shadow host is sized to the player root (which has
    // overflow: hidden), so anything taller than the player gets
    // clipped at the bottom.  calc(100% - panelTop - 20) ensures the
    // panel never exceeds the player height minus its top offset and
    // ~20px bottom buffer — fits on default-mode players (~480-720px
    // tall) without the bottom UI being cut off.
    maxHeight: `min(75vh, 640px, calc(100% - ${panelTop + 20}px))`,
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

function supportLinkStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    marginBottom: "10px",
    padding: "6px 8px",
    borderRadius: "6px",
    background: "rgba(255, 213, 121, 0.12)",
    border: "1px solid rgba(255, 213, 121, 0.25)",
    color: "#ffd479",
    fontSize: "12px",
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
    pointerEvents: "auto",
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

/** Clickable header row for a collapsible Section / LayerStyleBlock.
    Transparent + full-width so it reads as the section title, not a
    button; the chevron is the only added affordance. */
function collapsibleHeaderStyle(collapsed: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "6px",
    flex: "1 1 auto",
    minWidth: 0,
    padding: 0,
    margin: 0,
    marginBottom: collapsed ? 0 : "6px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };
}

// Row wrapper so a collapsed section can show a summary/interactive control to
// the RIGHT of the (flex-1) toggle button without nesting a control inside it.
function collapsibleHeaderRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
  };
}
function collapsibleHeaderTrailingStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    flex: "0 0 auto",
    maxWidth: "58%",
  };
}
// Muted one-line summary text shown when a section is collapsed.
function collapsedSummaryTextStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.55)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}
// Small hue dot used in summaries to identify a line by its color.
function summaryColorDotStyle(color: string): React.CSSProperties {
  return {
    width: "9px",
    height: "9px",
    borderRadius: "2px",
    background: color,
    border: "1px solid rgba(255, 255, 255, 0.35)",
    boxSizing: "border-box",
    flex: "0 0 auto",
  };
}

function collapseChevronStyle(): React.CSSProperties {
  return {
    fontSize: "9px",
    lineHeight: 1,
    color: "rgba(255, 255, 255, 0.45)",
    flexShrink: 0,
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

function dictLangRowStyle(): React.CSSProperties {
  return { display: "flex", alignItems: "center", padding: "2px 0" };
}

function dictLangSelectStyle(): React.CSSProperties {
  return {
    width: "100%",
    appearance: "auto",
    background: "rgba(255,255,255,0.08)",
    color: "#e6ebf2",
    border: "1px solid rgba(255,255,255,0.16)",
    borderRadius: "5px",
    fontSize: "12px",
    padding: "4px 6px",
    cursor: "pointer",
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

function colorRowOuterStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
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

function wheelTriggerStyle(open: boolean, currentColor: string): React.CSSProperties {
  return {
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    border: open
      ? "2px solid rgba(93, 255, 170, 0.9)"
      : "1px solid rgba(255, 255, 255, 0.25)",
    background: `conic-gradient(from 0deg, #ff5c5c, #ffe05c, #5cff9e, #5cffff, #9b8aff, #ff5c9e, #ff5c5c)`,
    cursor: "pointer",
    padding: 0,
    fontSize: 0,
    boxShadow: open
      ? "0 0 0 2px rgba(93, 255, 170, 0.3)"
      : "0 0 0 1px rgba(0, 0, 0, 0.4)",
    transition: "box-shadow 120ms ease, border-color 120ms ease",
    color: currentColor,
  };
}

function wheelPopoverStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px",
    borderRadius: "6px",
    background: "rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    marginTop: "2px",
  };
}

function wheelFooterStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    paddingTop: "4px",
  };
}

function wheelHexInputStyle(): React.CSSProperties {
  return {
    flex: "1 1 auto",
    padding: "4px 6px",
    borderRadius: "4px",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    background: "rgba(255, 255, 255, 0.06)",
    color: "#fff",
    fontFamily: "system-ui, -apple-system, monospace",
    fontSize: "11px",
    outline: "none",
    letterSpacing: "0.04em",
  };
}

function wheelSwatchStyle(hex: string): React.CSSProperties {
  return {
    width: "20px",
    height: "20px",
    borderRadius: "4px",
    border: "1px solid rgba(255, 255, 255, 0.25)",
    background: hex,
    flex: "0 0 auto",
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

function layerStyleBlockStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px",
    borderRadius: "6px",
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(255, 255, 255, 0.06)",
    marginBottom: "6px",
  };
}

function layerStyleHeaderStyle(): React.CSSProperties {
  return {
    fontSize: "12px",
    fontWeight: 500,
    color: "rgba(255, 255, 255, 0.85)",
    marginBottom: "2px",
  };
}

function layerStyleRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
  };
}

function layerStyleRowLabelStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.5)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };
}

function advancedToggleStyle(open: boolean): React.CSSProperties {
  return {
    marginTop: "4px",
    padding: "5px 8px",
    borderRadius: "4px",
    border: open
      ? "1px solid rgba(93, 138, 255, 0.35)"
      : "1px solid rgba(255, 255, 255, 0.08)",
    background: open
      ? "rgba(93, 138, 255, 0.12)"
      : "rgba(255, 255, 255, 0.02)",
    color: open ? "#9bb8ff" : "rgba(255, 255, 255, 0.55)",
    fontFamily: "inherit",
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    cursor: "pointer",
    width: "fit-content",
    alignSelf: "flex-end",
  };
}

function advancedBlockStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "6px 0 2px",
    marginTop: "2px",
    borderTop: "1px solid rgba(255, 255, 255, 0.04)",
  };
}

function percentLabelRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "6px",
  };
}

function percentValueStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.6)",
    fontVariantNumeric: "tabular-nums",
  };
}

function sliderStyle(): React.CSSProperties {
  return {
    width: "100%",
    accentColor: "#9bb8ff",
    cursor: "pointer",
  };
}

function presetPickerWrapperStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px",
    borderRadius: "6px",
    background: "rgba(93, 138, 255, 0.06)",
    border: "1px solid rgba(93, 138, 255, 0.18)",
    marginBottom: "8px",
  };
}

function presetPickerHeaderStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "8px",
  };
}

function presetPickerCurrentStyle(): React.CSSProperties {
  return {
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.55)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "180px",
  };
}

function presetSwatchesRowStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    flex: "0 0 auto",
  };
}

// Active = full color; inactive = the SAME hue dimmed (never neutral grey), so
// a row previews the whole scheme while showing which colors the current setup
// actually paints.
function presetSwatchStyle(color: string, active: boolean): React.CSSProperties {
  return {
    width: "12px",
    height: "12px",
    borderRadius: "3px",
    background: color,
    opacity: active ? 1 : 0.22,
    border: "1px solid rgba(255, 255, 255, 0.35)",
    boxSizing: "border-box",
    flex: "0 0 auto",
  };
}

function presetSepStyle(): React.CSSProperties {
  return {
    flex: "0 0 auto",
    color: "rgba(255, 255, 255, 0.25)",
    fontSize: "12px",
    margin: "0 2px",
  };
}

function presetGroupHeaderStyle(): React.CSSProperties {
  return {
    padding: "6px 8px 2px",
    fontSize: "9px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "rgba(255, 255, 255, 0.4)",
    userSelect: "none",
  };
}

function presetPickerPlaceholderStyle(): React.CSSProperties {
  return {
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.45)",
    fontStyle: "italic",
    padding: "4px 0",
  };
}

function variantPreviewStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "10px 8px",
    borderRadius: "6px",
    background: "rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.05)",
    marginBottom: "6px",
  };
}

function variantPreviewLabelStyle(): React.CSSProperties {
  return {
    fontSize: "9px",
    color: "rgba(255, 255, 255, 0.4)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  };
}

function variantPreviewContentStyle(): React.CSSProperties {
  return {
    display: "flex",
    justifyContent: "space-around",
    alignItems: "flex-end",
    gap: "12px",
    fontSize: "26px",
    fontFamily:
      "'Noto Sans TC', 'Noto Sans JP', 'Noto Sans SC', system-ui, sans-serif",
    lineHeight: 1.6,
    paddingTop: "4px",
    paddingBottom: "2px",
  };
}

function variantPreviewColumnStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
  };
}

function variantPreviewCaseLabelStyle(): React.CSSProperties {
  return {
    fontSize: "9px",
    color: "rgba(255, 255, 255, 0.55)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontFamily: "system-ui, -apple-system, sans-serif",
  };
}

function variantPreviewMergeRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-end",
    gap: "8px",
  };
}

function variantPreviewPlusStyle(): React.CSSProperties {
  return {
    fontSize: "16px",
    color: "rgba(255, 255, 255, 0.4)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    alignSelf: "center",
  };
}

function variantInlineLabelRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  };
}

function variantHintStrongStyle(): React.CSSProperties {
  return {
    color: "rgba(255, 255, 255, 0.65)",
    fontWeight: 600,
  };
}

function numberInputStyle(): React.CSSProperties {
  return {
    width: "80px",
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

function footerStyle(): React.CSSProperties {
  return {
    marginTop: "14px",
    paddingTop: "10px",
    borderTop: "1px solid rgba(255, 255, 255, 0.1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.4)",
  };
}

function footerLinkStyle(): React.CSSProperties {
  return {
    color: "rgba(255, 255, 255, 0.55)",
    textDecoration: "none",
  };
}
