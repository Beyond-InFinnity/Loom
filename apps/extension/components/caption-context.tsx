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
  setTargetTrack as discoverSetTargetTrack,
  subscribeToCaptions,
  type DiscoveryStatus,
} from "@/lib/captions/discover";
import { CaptionStream } from "@/lib/captions/stream";
import type { CaptionEvent, CaptionTrack } from "@/lib/captions/types";
import {
  hideYtCaptions,
  restoreYtCaptions,
} from "@/lib/overlay/hide-yt-captions";

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
  /** Resolved (override-or-auto) target/native track.  Drives the
      settings panel's "currently selected" highlight. */
  selectedTarget: CaptionTrack | null;
  selectedNative: CaptionTrack | null;
  isUserPickedTarget: boolean;
  isUserPickedNative: boolean;
  /** Base BCP-47 lang code used for native auto-pick. */
  nativeLangPref: string;

  /** Setters wired into discover.ts.  Pass null to revert to
      auto-pick. */
  setTargetTrack: (track: CaptionTrack | null) => void;
  setNativeTrack: (track: CaptionTrack | null) => void;
  setNativeLangPref: (code: string) => void;
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
  const [nativeLangPref, setNativeLangPrefState] = useState("en");

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

  const setTargetTrack = useCallback((track: CaptionTrack | null) => {
    discoverSetTargetTrack(track);
  }, []);
  const setNativeTrack = useCallback((track: CaptionTrack | null) => {
    discoverSetNativeTrack(track);
  }, []);
  const setNativeLangPref = useCallback((code: string) => {
    discoverSetNativeLangPref(code);
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
      nativeLangPref,
      setTargetTrack,
      setNativeTrack,
      setNativeLangPref,
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
      nativeLangPref,
      setTargetTrack,
      setNativeTrack,
      setNativeLangPref,
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
