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
  notifyActiveEvent as discoverNotifyActiveEvent,
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
const STORAGE_KEY_TARGET_POSITION = "loom_target_position";
const STORAGE_KEY_NATIVE_POSITION = "loom_native_position";
const DEFAULT_TOP_COLOR = "#ffffff";
const DEFAULT_BOTTOM_COLOR = "#ffffff";

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

  /** Setters wired into discover.ts.  Pass null to revert to
      auto-pick. */
  setTargetTrack: (track: CaptionTrack | null) => void;
  setNativeTrack: (track: CaptionTrack | null) => void;
  setTargetTranslateTo: (code: string | null) => void;
  setNativeTranslateTo: (code: string | null) => void;
  setNativeLangPref: (code: string) => void;
  setTopColor: (hex: string) => void;
  setBottomColor: (hex: string) => void;
  /** Position setters auto-swap when the requested slot is already
      occupied by the other track, so state stays collision-free. */
  setTargetPosition: (pos: CaptionPosition) => void;
  setNativePosition: (pos: CaptionPosition) => void;
  /** Annotation setters — discover.ts persists + re-fetches. */
  setTargetAnnotateEnabled: (v: boolean) => void;
  setNativeAnnotateEnabled: (v: boolean) => void;
  setTargetPhoneticSystem: (code: string | null) => void;
  setNativePhoneticSystem: (code: string | null) => void;
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
          // Anchor the rolling annotation window at the current
          // event boundary.  discover.ts dedups against its cache,
          // so cheap when the window is already prefetched.
          discoverNotifyActiveEvent(d.target, d.native);
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
          STORAGE_KEY_TARGET_POSITION,
          STORAGE_KEY_NATIVE_POSITION,
        ]);
        const top = result[STORAGE_KEY_TOP_COLOR];
        const bottom = result[STORAGE_KEY_BOTTOM_COLOR];
        const tPos = result[STORAGE_KEY_TARGET_POSITION];
        const nPos = result[STORAGE_KEY_NATIVE_POSITION];
        if (typeof top === "string" && top.length > 0) setTopColorState(top);
        if (typeof bottom === "string" && bottom.length > 0)
          setBottomColorState(bottom);
        if (isCaptionPosition(tPos) && isCaptionPosition(nPos) && tPos !== nPos) {
          // Both validated AND non-colliding.  Anything else falls
          // back to defaults so we never start in a broken state.
          setTargetPositionState(tPos);
          setNativePositionState(nPos);
        }
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
      targetPosition,
      nativePosition,
      targetAnnotateEnabled,
      nativeAnnotateEnabled,
      targetPhoneticSystem,
      nativePhoneticSystem,
      targetAnnotateMap,
      nativeAnnotateMap,
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
      targetPosition,
      nativePosition,
      targetAnnotateEnabled,
      nativeAnnotateEnabled,
      targetPhoneticSystem,
      nativePhoneticSystem,
      targetAnnotateMap,
      nativeAnnotateMap,
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
