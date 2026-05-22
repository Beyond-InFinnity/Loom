import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  setNativeAnnotateEnabled as discoverSetNativeAnnotateEnabled,
  setNativeLangPref as discoverSetNativeLangPref,
  setNativePhoneticSystem as discoverSetNativePhoneticSystem,
  setNativeTrack as discoverSetNativeTrack,
  setNativeTranslateTo as discoverSetNativeTranslateTo,
  setTargetAnnotateEnabled as discoverSetTargetAnnotateEnabled,
  setTargetPhoneticSystem as discoverSetTargetPhoneticSystem,
  setTargetTrack as discoverSetTargetTrack,
  setTargetTranslateTo as discoverSetTargetTranslateTo,
  subscribeToCaptions,
  type DiscoveryStatus,
} from "@/lib/captions/discover";
import { CaptionStream } from "@/lib/captions/stream";
import type { CaptionEvent, CaptionTrack } from "@/lib/captions/types";
import type { AnnotateMap } from "@/lib/annotate/types";
import {
  hideYtCaptions,
  restoreYtCaptions,
} from "@/lib/overlay/hide-yt-captions";

// Color + position preferences live in caption-context (not discover.ts)
// because they're presentation state, not caption-discovery state.
// All persisted to browser.storage.local; load is fire-and-forget on
// mount, default values render until the storage read lands.
const STORAGE_KEY_TOP_COLOR = "loom_top_color";
const STORAGE_KEY_BOTTOM_COLOR = "loom_bottom_color";
const STORAGE_KEY_ANNOTATION_COLOR = "loom_annotation_color";
const STORAGE_KEY_TARGET_POSITION = "loom_target_position";
const STORAGE_KEY_NATIVE_POSITION = "loom_native_position";
// Per-layer typography (added when desktop's StyleConfig was ported
// piecemeal — color first, then font family + size).  All persisted.
const STORAGE_KEY_TOP_FONT_FAMILY = "loom_top_font_family";
const STORAGE_KEY_BOTTOM_FONT_FAMILY = "loom_bottom_font_family";
const STORAGE_KEY_ANNOTATION_FONT_FAMILY = "loom_annotation_font_family";
const STORAGE_KEY_TOP_FONT_SIZE = "loom_top_font_size_px";
const STORAGE_KEY_BOTTOM_FONT_SIZE = "loom_bottom_font_size_px";
const STORAGE_KEY_ANNOTATION_FONT_RATIO = "loom_annotation_font_ratio";
// Alternate-orthography (under-ruby) layer.  Per-layer enable so the
// user can turn on under-ruby for their learning lang without polluting
// the native layer.  Highlight + colors are SHARED across layers so a
// "what does this color mean" affordance stays consistent visually.
const STORAGE_KEY_TARGET_VARIANT_ENABLED = "loom_target_variant_enabled";
const STORAGE_KEY_NATIVE_VARIANT_ENABLED = "loom_native_variant_enabled";
const STORAGE_KEY_VARIANT_HIGHLIGHT = "loom_variant_highlight_enabled";
const STORAGE_KEY_VARIANT_COLOR = "loom_variant_color";
const STORAGE_KEY_VARIANT_CLEAN_COLOR = "loom_variant_clean_color";
const STORAGE_KEY_VARIANT_COLLAPSE_COLOR = "loom_variant_collapse_color";
const DEFAULT_TOP_COLOR = "#ffffff";
const DEFAULT_BOTTOM_COLOR = "#ffffff";
const DEFAULT_ANNOTATION_COLOR = "#ffffff";
/** "auto" sentinel means use the overlay's default cross-script
    Noto-fallback FONT_STACK from caption-overlay.tsx.  Any other
    string is a CSS font-family value used verbatim. */
const DEFAULT_FONT_FAMILY = "auto";
const DEFAULT_TOP_FONT_SIZE_PX = 52;
const DEFAULT_BOTTOM_FONT_SIZE_PX = 48;
/** Annotation font is sized as a fraction of the TOP font (matches
    loom_core/styles.py::annotation_font_ratio).  0.5 for CJK ruby,
    0.4 for alphabetic.  User can override per-track. */
const DEFAULT_ANNOTATION_FONT_RATIO = 0.5;
const DEFAULT_VARIANT_COLOR = "#ffffff";
const DEFAULT_VARIANT_CLEAN_COLOR = "#5cffff";       // soft cyan — 1:1 mapping
const DEFAULT_VARIANT_COLLAPSE_COLOR = "#ffcc5c";   // soft amber — forward-collapse

/** Slot a track occupies on screen.
    - top-1    : top of player, upper line of top zone (visually highest)
    - top-2    : top of player, lower line of top zone
    - bottom-1 : bottom of player, upper line of bottom zone
    - bottom-2 : bottom of player, lower line of bottom zone (visually lowest)

    Solo case (only one track in a zone): the slot-1/slot-2 distinction
    is irrelevant — flex layout collapses the single layer onto the
    zone's anchor edge.  See caption-overlay.tsx for the rendering. */
export type CaptionPosition = "top-1" | "top-2" | "bottom-1" | "bottom-2";

const VALID_POSITIONS: CaptionPosition[] = [
  "top-1",
  "top-2",
  "bottom-1",
  "bottom-2",
];
const DEFAULT_TARGET_POSITION: CaptionPosition = "bottom-1";
const DEFAULT_NATIVE_POSITION: CaptionPosition = "bottom-2";

function isCaptionPosition(v: unknown): v is CaptionPosition {
  return typeof v === "string" && (VALID_POSITIONS as string[]).includes(v);
}

interface CaptionContextValue {
  /** Lifecycle status from discovery — drives the pill + overlay
      visibility decisions. */
  status: DiscoveryStatus;
  /** Currently active target / native events at the playhead.  null
      between events or when not tracking. */
  target: CaptionEvent | null;
  native: CaptionEvent | null;

  /** Underlying CaptionStream — exposed for components that need
      direct read access (rare).  Tests live downstream. */
  stream: CaptionStream;

  /** All caption tracks discovered for the current video.  Empty
      until phase-1 discovery completes. */
  tracks: CaptionTrack[];
  /** Resolved (override-or-auto) target/native SOURCE track.  Drives
      the settings panel's "currently selected" highlight. */
  selectedTarget: CaptionTrack | null;
  selectedNative: CaptionTrack | null;
  isUserPickedTarget: boolean;
  isUserPickedNative: boolean;
  /** User-set tlang= per layer.  null = no MT. */
  targetTranslateTo: string | null;
  nativeTranslateTo: string | null;
  /** Base BCP-47 lang code used for native auto-pick. */
  nativeLangPref: string;

  /** Per-layer text color (hex).  Persisted to browser.storage.local. */
  topColor: string;
  bottomColor: string;
  /** Color of the annotation reading (<rt> in ruby).  Distinct from
      topColor so the user can e.g. have white kanji + soft-yellow
      furigana without dragging colors together. */
  annotationColor: string;
  /** Per-layer font family.  "auto" sentinel = the cross-script
      Noto-fallback stack; any other string is verbatim CSS. */
  topFontFamily: string;
  bottomFontFamily: string;
  annotationFontFamily: string;
  /** Per-layer font size.  Top + Bottom in absolute CSS pixels at
      1080p reference (scaled by usePlayerScale at render time);
      annotation as a ratio of the TOP layer's size (matches the
      desktop's annotation_font_ratio convention). */
  topFontSizePx: number;
  bottomFontSizePx: number;
  annotationFontRatio: number;

  /** Per-track screen position.  See CaptionPosition above.  Persisted. */
  targetPosition: CaptionPosition;
  nativePosition: CaptionPosition;

  /** Per-track annotation enable + phonetic-system override.
      Persisted by discover.ts. */
  targetAnnotateEnabled: boolean;
  nativeAnnotateEnabled: boolean;
  /** null = backend decides; otherwise pinyin / zhuyin / jyutping
      (Chinese variants) or rtgs / paiboon / ipa (Thai). */
  targetPhoneticSystem: string | null;
  nativePhoneticSystem: string | null;
  /** Annotation maps keyed by event text.  null while loading or
      when annotation is disabled.  Consumed by caption-overlay to
      render <ruby> for the currently-active event. */
  targetAnnotateMap: AnnotateMap | null;
  nativeAnnotateMap: AnnotateMap | null;

  /** Per-layer alternate-orthography enable.  Resolves to under-ruby
      rendering (e.g. zh-Hant base + zh-Hans below) when the layer's
      lang has a registered variant table.  Persisted. */
  targetVariantEnabled: boolean;
  nativeVariantEnabled: boolean;
  /** When true (default), in-table base chars are coloured by tier
      (clean vs collapse).  When false, only the under-rt renders. */
  variantHighlightEnabled: boolean;
  /** Colors — shared across layers for visual consistency.
      `variantColor` is the under-rt; the two highlight colors are
      applied to the BASE glyph at render time. */
  variantColor: string;
  variantCleanColor: string;
  variantCollapseColor: string;

  /** Setters wired into discover.ts.  Pass null to revert to
      auto-pick. */
  setTargetTrack: (track: CaptionTrack | null) => void;
  setNativeTrack: (track: CaptionTrack | null) => void;
  setTargetTranslateTo: (code: string | null) => void;
  setNativeTranslateTo: (code: string | null) => void;
  setNativeLangPref: (code: string) => void;
  setTopColor: (hex: string) => void;
  setBottomColor: (hex: string) => void;
  setAnnotationColor: (hex: string) => void;
  setTopFontFamily: (family: string) => void;
  setBottomFontFamily: (family: string) => void;
  setAnnotationFontFamily: (family: string) => void;
  setTopFontSizePx: (px: number) => void;
  setBottomFontSizePx: (px: number) => void;
  setAnnotationFontRatio: (ratio: number) => void;
  /** Position setters auto-swap when the requested slot is already
      occupied by the other track, so state stays collision-free. */
  setTargetPosition: (pos: CaptionPosition) => void;
  setNativePosition: (pos: CaptionPosition) => void;
  /** Annotation setters — discover.ts persists + re-fetches. */
  setTargetAnnotateEnabled: (v: boolean) => void;
  setNativeAnnotateEnabled: (v: boolean) => void;
  setTargetPhoneticSystem: (code: string | null) => void;
  setNativePhoneticSystem: (code: string | null) => void;
  /** Alternate-orthography setters.  Per-layer enable; shared highlight
      + colors. */
  setTargetVariantEnabled: (v: boolean) => void;
  setNativeVariantEnabled: (v: boolean) => void;
  setVariantHighlightEnabled: (v: boolean) => void;
  setVariantColor: (hex: string) => void;
  setVariantCleanColor: (hex: string) => void;
  setVariantCollapseColor: (hex: string) => void;
}

const CaptionContext = createContext<CaptionContextValue | null>(null);

export function CaptionStreamProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DiscoveryStatus>({ kind: "idle" });
  const [target, setTarget] = useState<CaptionEvent | null>(null);
  const [native, setNative] = useState<CaptionEvent | null>(null);
  const [tracks, setTracks] = useState<CaptionTrack[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<CaptionTrack | null>(
    null,
  );
  const [selectedNative, setSelectedNative] = useState<CaptionTrack | null>(
    null,
  );
  const [isUserPickedTarget, setIsUserPickedTarget] = useState(false);
  const [isUserPickedNative, setIsUserPickedNative] = useState(false);
  const [targetTranslateTo, setTargetTranslateToState] = useState<
    string | null
  >(null);
  const [nativeTranslateTo, setNativeTranslateToState] = useState<
    string | null
  >(null);
  const [nativeLangPref, setNativeLangPrefState] = useState("en");
  const [topColor, setTopColorState] = useState(DEFAULT_TOP_COLOR);
  const [bottomColor, setBottomColorState] = useState(DEFAULT_BOTTOM_COLOR);
  const [annotationColor, setAnnotationColorState] = useState(
    DEFAULT_ANNOTATION_COLOR,
  );
  const [topFontFamily, setTopFontFamilyState] = useState(DEFAULT_FONT_FAMILY);
  const [bottomFontFamily, setBottomFontFamilyState] =
    useState(DEFAULT_FONT_FAMILY);
  const [annotationFontFamily, setAnnotationFontFamilyState] =
    useState(DEFAULT_FONT_FAMILY);
  const [topFontSizePx, setTopFontSizePxState] = useState(
    DEFAULT_TOP_FONT_SIZE_PX,
  );
  const [bottomFontSizePx, setBottomFontSizePxState] = useState(
    DEFAULT_BOTTOM_FONT_SIZE_PX,
  );
  const [annotationFontRatio, setAnnotationFontRatioState] = useState(
    DEFAULT_ANNOTATION_FONT_RATIO,
  );
  const [targetPosition, setTargetPositionState] = useState<CaptionPosition>(
    DEFAULT_TARGET_POSITION,
  );
  const [nativePosition, setNativePositionState] = useState<CaptionPosition>(
    DEFAULT_NATIVE_POSITION,
  );
  // Annotation state piped from discover.ts payload — discover owns
  // persistence + the fetch lifecycle; we just mirror for context
  // consumers.  Setters delegate back into discover via the imported
  // discoverSet* functions.
  const [targetAnnotateEnabled, setTargetAnnotateEnabledState] = useState(true);
  const [nativeAnnotateEnabled, setNativeAnnotateEnabledState] =
    useState(false);
  const [targetPhoneticSystem, setTargetPhoneticSystemState] = useState<
    string | null
  >(null);
  const [nativePhoneticSystem, setNativePhoneticSystemState] = useState<
    string | null
  >(null);
  const [targetAnnotateMap, setTargetAnnotateMapState] =
    useState<AnnotateMap | null>(null);
  const [nativeAnnotateMap, setNativeAnnotateMapState] =
    useState<AnnotateMap | null>(null);
  const [targetVariantEnabled, setTargetVariantEnabledState] = useState(false);
  const [nativeVariantEnabled, setNativeVariantEnabledState] = useState(false);
  const [variantHighlightEnabled, setVariantHighlightEnabledState] =
    useState(true);
  const [variantColor, setVariantColorState] = useState(DEFAULT_VARIANT_COLOR);
  const [variantCleanColor, setVariantCleanColorState] = useState(
    DEFAULT_VARIANT_CLEAN_COLOR,
  );
  const [variantCollapseColor, setVariantCollapseColorState] = useState(
    DEFAULT_VARIANT_COLLAPSE_COLOR,
  );

  const stream = useMemo(
    () =>
      new CaptionStream({
        onStatusChange: (s) => {
          // CaptionStream emits its own status (idle/detecting/
          // tracking/unsupported/error).  We treat the discovery
          // payload as authoritative for the outer status; the
          // stream's status is just internal lifecycle plumbing.
          // No-op here; status comes from the discover subscription.
          void s;
        },
        onActiveChange: (d) => {
          setTarget(d.target);
          setNative(d.native);
          // No annotation-fetch trigger here (5d-perf v3): the
          // /annotate/batch one-shot at track-resolve time pre-
          // populates the entire map, so playhead boundaries don't
          // need to drive any network or cache work.
        },
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = subscribeToCaptions((payload) => {
      setStatus(payload.status);
      setTracks(payload.tracks);
      setSelectedTarget(payload.selectedTarget);
      setSelectedNative(payload.selectedNative);
      setIsUserPickedTarget(payload.isUserPickedTarget);
      setIsUserPickedNative(payload.isUserPickedNative);
      setTargetTranslateToState(payload.targetTranslateTo);
      setNativeTranslateToState(payload.nativeTranslateTo);
      setNativeLangPrefState(payload.nativeLangPref);
      setTargetAnnotateEnabledState(payload.targetAnnotateEnabled);
      setNativeAnnotateEnabledState(payload.nativeAnnotateEnabled);
      setTargetPhoneticSystemState(payload.targetPhoneticSystem);
      setNativePhoneticSystemState(payload.nativePhoneticSystem);
      setTargetAnnotateMapState(payload.targetAnnotateMap);
      setNativeAnnotateMapState(payload.nativeAnnotateMap);

      const s = payload.status;
      if (s.kind === "tracking" && payload.targetEvents) {
        hideYtCaptions();
        stream.start({
          targetEvents: payload.targetEvents,
          nativeEvents: payload.nativeEvents ?? [],
          targetLang: s.targetLang,
          nativeLang: s.nativeLang,
        });
      } else if (s.kind === "unsupported") {
        restoreYtCaptions();
        stream.setUnsupported(s.reason);
      } else if (s.kind === "error") {
        restoreYtCaptions();
        stream.setError(s.message);
      } else if (s.kind === "discovering") {
        // Keep current stream state — re-resolve is in flight.  When
        // it lands as `tracking`, stream.start swaps in new events.
        // YT captions stay hidden during the brief in-flight window
        // because we hid them on the previous `tracking` emit and
        // haven't called restore.
      }
    });
    return () => {
      unsubscribe();
      restoreYtCaptions();
      stream.stop();
    };
  }, [stream]);

  // One-shot load of persisted color + position preferences.  Fire-
  // and-forget; unpersisted defaults render until the storage read
  // lands.  Position values are validated against VALID_POSITIONS so a
  // stale/corrupt entry doesn't poison render — we silently fall back
  // to the default.
  useEffect(() => {
    void (async () => {
      try {
        const result = await browser.storage.local.get([
          STORAGE_KEY_TOP_COLOR,
          STORAGE_KEY_BOTTOM_COLOR,
          STORAGE_KEY_ANNOTATION_COLOR,
          STORAGE_KEY_TARGET_POSITION,
          STORAGE_KEY_NATIVE_POSITION,
          STORAGE_KEY_TOP_FONT_FAMILY,
          STORAGE_KEY_BOTTOM_FONT_FAMILY,
          STORAGE_KEY_ANNOTATION_FONT_FAMILY,
          STORAGE_KEY_TOP_FONT_SIZE,
          STORAGE_KEY_BOTTOM_FONT_SIZE,
          STORAGE_KEY_ANNOTATION_FONT_RATIO,
          STORAGE_KEY_TARGET_VARIANT_ENABLED,
          STORAGE_KEY_NATIVE_VARIANT_ENABLED,
          STORAGE_KEY_VARIANT_HIGHLIGHT,
          STORAGE_KEY_VARIANT_COLOR,
          STORAGE_KEY_VARIANT_CLEAN_COLOR,
          STORAGE_KEY_VARIANT_COLLAPSE_COLOR,
        ]);
        const top = result[STORAGE_KEY_TOP_COLOR];
        const bottom = result[STORAGE_KEY_BOTTOM_COLOR];
        const ann = result[STORAGE_KEY_ANNOTATION_COLOR];
        const tPos = result[STORAGE_KEY_TARGET_POSITION];
        const nPos = result[STORAGE_KEY_NATIVE_POSITION];
        if (typeof top === "string" && top.length > 0) setTopColorState(top);
        if (typeof bottom === "string" && bottom.length > 0)
          setBottomColorState(bottom);
        if (typeof ann === "string" && ann.length > 0)
          setAnnotationColorState(ann);
        if (isCaptionPosition(tPos) && isCaptionPosition(nPos) && tPos !== nPos) {
          // Both validated AND non-colliding.  Anything else falls
          // back to defaults so we never start in a broken state.
          setTargetPositionState(tPos);
          setNativePositionState(nPos);
        }
        // Font family — any non-empty string is acceptable as a CSS
        // font-family value.  Defaults guarantee at least DEFAULT_FONT_FAMILY.
        const tFont = result[STORAGE_KEY_TOP_FONT_FAMILY];
        const bFont = result[STORAGE_KEY_BOTTOM_FONT_FAMILY];
        const aFont = result[STORAGE_KEY_ANNOTATION_FONT_FAMILY];
        if (typeof tFont === "string" && tFont.length > 0)
          setTopFontFamilyState(tFont);
        if (typeof bFont === "string" && bFont.length > 0)
          setBottomFontFamilyState(bFont);
        if (typeof aFont === "string" && aFont.length > 0)
          setAnnotationFontFamilyState(aFont);
        // Font sizes — defensive numeric clamps so a stored garbage
        // value can't render a 1-px or 10,000-px overlay.
        const tSize = result[STORAGE_KEY_TOP_FONT_SIZE];
        const bSize = result[STORAGE_KEY_BOTTOM_FONT_SIZE];
        const aRatio = result[STORAGE_KEY_ANNOTATION_FONT_RATIO];
        if (typeof tSize === "number" && tSize >= 12 && tSize <= 120)
          setTopFontSizePxState(tSize);
        if (typeof bSize === "number" && bSize >= 12 && bSize <= 120)
          setBottomFontSizePxState(bSize);
        if (typeof aRatio === "number" && aRatio >= 0.2 && aRatio <= 1.0)
          setAnnotationFontRatioState(aRatio);
        // Variant prefs — booleans validated as actual booleans (avoid
        // truthy-coercion of stale "true"/"false" strings); colors
        // accept any non-empty string (the native color input will
        // validate format at the UI layer).
        const tVar = result[STORAGE_KEY_TARGET_VARIANT_ENABLED];
        const nVar = result[STORAGE_KEY_NATIVE_VARIANT_ENABLED];
        const vHigh = result[STORAGE_KEY_VARIANT_HIGHLIGHT];
        if (typeof tVar === "boolean") setTargetVariantEnabledState(tVar);
        if (typeof nVar === "boolean") setNativeVariantEnabledState(nVar);
        if (typeof vHigh === "boolean") setVariantHighlightEnabledState(vHigh);
        const vCol = result[STORAGE_KEY_VARIANT_COLOR];
        const vClean = result[STORAGE_KEY_VARIANT_CLEAN_COLOR];
        const vColl = result[STORAGE_KEY_VARIANT_COLLAPSE_COLOR];
        if (typeof vCol === "string" && vCol.length > 0) setVariantColorState(vCol);
        if (typeof vClean === "string" && vClean.length > 0)
          setVariantCleanColorState(vClean);
        if (typeof vColl === "string" && vColl.length > 0)
          setVariantCollapseColorState(vColl);
      } catch (e) {
        console.warn("[Loom] failed to load presentation prefs:", e);
      }
    })();
  }, []);

  const setTargetTrack = useCallback((track: CaptionTrack | null) => {
    discoverSetTargetTrack(track);
  }, []);
  const setNativeTrack = useCallback((track: CaptionTrack | null) => {
    discoverSetNativeTrack(track);
  }, []);
  const setTargetTranslateTo = useCallback((code: string | null) => {
    discoverSetTargetTranslateTo(code);
  }, []);
  const setNativeTranslateTo = useCallback((code: string | null) => {
    discoverSetNativeTranslateTo(code);
  }, []);
  const setNativeLangPref = useCallback((code: string) => {
    discoverSetNativeLangPref(code);
  }, []);
  const setTopColor = useCallback((hex: string) => {
    setTopColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_COLOR]: hex })
      .catch((e) => console.warn("[Loom] failed to persist topColor:", e));
  }, []);
  const setBottomColor = useCallback((hex: string) => {
    setBottomColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_COLOR]: hex })
      .catch((e) => console.warn("[Loom] failed to persist bottomColor:", e));
  }, []);
  const setAnnotationColor = useCallback((hex: string) => {
    setAnnotationColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_ANNOTATION_COLOR]: hex })
      .catch((e) =>
        console.warn("[Loom] failed to persist annotationColor:", e),
      );
  }, []);
  const setTopFontFamily = useCallback((family: string) => {
    setTopFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_FONT_FAMILY]: family })
      .catch((e) => console.warn("[Loom] persist topFontFamily:", e));
  }, []);
  const setBottomFontFamily = useCallback((family: string) => {
    setBottomFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_FONT_FAMILY]: family })
      .catch((e) => console.warn("[Loom] persist bottomFontFamily:", e));
  }, []);
  const setAnnotationFontFamily = useCallback((family: string) => {
    setAnnotationFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_ANNOTATION_FONT_FAMILY]: family })
      .catch((e) => console.warn("[Loom] persist annotationFontFamily:", e));
  }, []);
  const setTopFontSizePx = useCallback((px: number) => {
    // Defensive clamp — UI should already constrain, but a stray
    // setState from a custom integration shouldn't break layout.
    const clamped = Math.max(12, Math.min(120, px));
    setTopFontSizePxState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_FONT_SIZE]: clamped })
      .catch((e) => console.warn("[Loom] persist topFontSizePx:", e));
  }, []);
  const setBottomFontSizePx = useCallback((px: number) => {
    const clamped = Math.max(12, Math.min(120, px));
    setBottomFontSizePxState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_FONT_SIZE]: clamped })
      .catch((e) => console.warn("[Loom] persist bottomFontSizePx:", e));
  }, []);
  const setAnnotationFontRatio = useCallback((ratio: number) => {
    const clamped = Math.max(0.2, Math.min(1.0, ratio));
    setAnnotationFontRatioState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_ANNOTATION_FONT_RATIO]: clamped })
      .catch((e) => console.warn("[Loom] persist annotationFontRatio:", e));
  }, []);

  // Position setters use functional setState so they read the latest
  // sibling-position (the OTHER track's slot) without needing it as a
  // dep.  When the requested slot is the sibling's current slot, swap
  // — sibling takes our old slot, we take the requested slot.  Keeps
  // the {target, native} pair always at two distinct slots.
  const setTargetPosition = useCallback((pos: CaptionPosition) => {
    setTargetPositionState((prevTarget) => {
      setNativePositionState((prevNative) => {
        const next = prevNative === pos ? prevTarget : prevNative;
        void browser.storage.local
          .set({ [STORAGE_KEY_NATIVE_POSITION]: next })
          .catch((e) =>
            console.warn("[Loom] failed to persist nativePosition:", e),
          );
        return next;
      });
      void browser.storage.local
        .set({ [STORAGE_KEY_TARGET_POSITION]: pos })
        .catch((e) =>
          console.warn("[Loom] failed to persist targetPosition:", e),
        );
      return pos;
    });
  }, []);

  const setTargetVariantEnabled = useCallback((v: boolean) => {
    setTargetVariantEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_TARGET_VARIANT_ENABLED]: v })
      .catch((e) => console.warn("[Loom] persist targetVariantEnabled:", e));
  }, []);
  const setNativeVariantEnabled = useCallback((v: boolean) => {
    setNativeVariantEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_NATIVE_VARIANT_ENABLED]: v })
      .catch((e) => console.warn("[Loom] persist nativeVariantEnabled:", e));
  }, []);
  const setVariantHighlightEnabled = useCallback((v: boolean) => {
    setVariantHighlightEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_HIGHLIGHT]: v })
      .catch((e) => console.warn("[Loom] persist variantHighlightEnabled:", e));
  }, []);
  const setVariantColor = useCallback((hex: string) => {
    setVariantColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist variantColor:", e));
  }, []);
  const setVariantCleanColor = useCallback((hex: string) => {
    setVariantCleanColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_CLEAN_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist variantCleanColor:", e));
  }, []);
  const setVariantCollapseColor = useCallback((hex: string) => {
    setVariantCollapseColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_COLLAPSE_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist variantCollapseColor:", e));
  }, []);

  const setTargetAnnotateEnabled = useCallback((v: boolean) => {
    discoverSetTargetAnnotateEnabled(v);
  }, []);
  const setNativeAnnotateEnabled = useCallback((v: boolean) => {
    discoverSetNativeAnnotateEnabled(v);
  }, []);
  const setTargetPhoneticSystem = useCallback((code: string | null) => {
    discoverSetTargetPhoneticSystem(code);
  }, []);
  const setNativePhoneticSystem = useCallback((code: string | null) => {
    discoverSetNativePhoneticSystem(code);
  }, []);

  const setNativePosition = useCallback((pos: CaptionPosition) => {
    setNativePositionState((prevNative) => {
      setTargetPositionState((prevTarget) => {
        const next = prevTarget === pos ? prevNative : prevTarget;
        void browser.storage.local
          .set({ [STORAGE_KEY_TARGET_POSITION]: next })
          .catch((e) =>
            console.warn("[Loom] failed to persist targetPosition:", e),
          );
        return next;
      });
      void browser.storage.local
        .set({ [STORAGE_KEY_NATIVE_POSITION]: pos })
        .catch((e) =>
          console.warn("[Loom] failed to persist nativePosition:", e),
        );
      return pos;
    });
  }, []);

  const value = useMemo<CaptionContextValue>(
    () => ({
      status,
      target,
      native,
      stream,
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
      annotationFontRatio,
      targetPosition,
      nativePosition,
      targetAnnotateEnabled,
      nativeAnnotateEnabled,
      targetPhoneticSystem,
      nativePhoneticSystem,
      targetAnnotateMap,
      nativeAnnotateMap,
      targetVariantEnabled,
      nativeVariantEnabled,
      variantHighlightEnabled,
      variantColor,
      variantCleanColor,
      variantCollapseColor,
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
      setAnnotationFontRatio,
      setTargetPosition,
      setNativePosition,
      setTargetAnnotateEnabled,
      setNativeAnnotateEnabled,
      setTargetPhoneticSystem,
      setNativePhoneticSystem,
      setTargetVariantEnabled,
      setNativeVariantEnabled,
      setVariantHighlightEnabled,
      setVariantColor,
      setVariantCleanColor,
      setVariantCollapseColor,
    }),
    [
      status,
      target,
      native,
      stream,
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
      annotationFontRatio,
      targetPosition,
      nativePosition,
      targetAnnotateEnabled,
      nativeAnnotateEnabled,
      targetPhoneticSystem,
      nativePhoneticSystem,
      targetAnnotateMap,
      nativeAnnotateMap,
      targetVariantEnabled,
      nativeVariantEnabled,
      variantHighlightEnabled,
      variantColor,
      variantCleanColor,
      variantCollapseColor,
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
      setAnnotationFontRatio,
      setTargetPosition,
      setNativePosition,
      setTargetAnnotateEnabled,
      setNativeAnnotateEnabled,
      setTargetPhoneticSystem,
      setNativePhoneticSystem,
      setTargetVariantEnabled,
      setNativeVariantEnabled,
      setVariantHighlightEnabled,
      setVariantColor,
      setVariantCleanColor,
      setVariantCollapseColor,
    ],
  );

  return (
    <CaptionContext.Provider value={value}>{children}</CaptionContext.Provider>
  );
}

export function useCaptionStream(): CaptionContextValue {
  const value = useContext(CaptionContext);
  if (!value) {
    throw new Error(
      "useCaptionStream must be called inside <CaptionStreamProvider>",
    );
  }
  return value;
}
