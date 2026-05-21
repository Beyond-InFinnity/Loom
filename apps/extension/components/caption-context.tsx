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
  setNativeLangPref as discoverSetNativeLangPref,
  setNativeTrack as discoverSetNativeTrack,
  setNativeTranslateTo as discoverSetNativeTranslateTo,
  setTargetTrack as discoverSetTargetTrack,
  setTargetTranslateTo as discoverSetTargetTranslateTo,
  subscribeToCaptions,
  type DiscoveryStatus,
} from "@/lib/captions/discover";
import { CaptionStream } from "@/lib/captions/stream";
import type { CaptionEvent, CaptionTrack } from "@/lib/captions/types";
import {
  hideYtCaptions,
  restoreYtCaptions,
} from "@/lib/overlay/hide-yt-captions";

// Color preferences live in caption-context (not discover.ts) because
// they're presentation state, not caption-discovery state.  Persisted
// to browser.storage.local so they survive page reloads; load is fire-
// and-forget on mount.
const STORAGE_KEY_TOP_COLOR = "loom_top_color";
const STORAGE_KEY_BOTTOM_COLOR = "loom_bottom_color";
const DEFAULT_TOP_COLOR = "#ffffff";
const DEFAULT_BOTTOM_COLOR = "#ffffff";

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

  /** Setters wired into discover.ts.  Pass null to revert to
      auto-pick. */
  setTargetTrack: (track: CaptionTrack | null) => void;
  setNativeTrack: (track: CaptionTrack | null) => void;
  setTargetTranslateTo: (code: string | null) => void;
  setNativeTranslateTo: (code: string | null) => void;
  setNativeLangPref: (code: string) => void;
  setTopColor: (hex: string) => void;
  setBottomColor: (hex: string) => void;
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

  // One-shot load of persisted color preferences.  Fire-and-forget;
  // unpersisted defaults render until the storage read lands.
  useEffect(() => {
    void (async () => {
      try {
        const result = await browser.storage.local.get([
          STORAGE_KEY_TOP_COLOR,
          STORAGE_KEY_BOTTOM_COLOR,
        ]);
        const top = result[STORAGE_KEY_TOP_COLOR];
        const bottom = result[STORAGE_KEY_BOTTOM_COLOR];
        if (typeof top === "string" && top.length > 0) setTopColorState(top);
        if (typeof bottom === "string" && bottom.length > 0)
          setBottomColorState(bottom);
      } catch (e) {
        console.warn("[Loom] failed to load color prefs:", e);
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
      setTargetTrack,
      setNativeTrack,
      setTargetTranslateTo,
      setNativeTranslateTo,
      setNativeLangPref,
      setTopColor,
      setBottomColor,
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
      setTargetTrack,
      setNativeTrack,
      setTargetTranslateTo,
      setNativeTranslateTo,
      setNativeLangPref,
      setTopColor,
      setBottomColor,
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
