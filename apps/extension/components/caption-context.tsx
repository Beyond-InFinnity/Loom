import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { subscribeToCaptions } from "@/lib/captions/discover";
import { CaptionStream } from "@/lib/captions/stream";
import type { CaptionEvent, StreamStatus } from "@/lib/captions/types";
import {
  hideYtCaptions,
  restoreYtCaptions,
} from "@/lib/overlay/hide-yt-captions";

interface CaptionContextValue {
  status: StreamStatus;
  target: CaptionEvent | null;
  native: CaptionEvent | null;
  stream: CaptionStream;
}

const CaptionContext = createContext<CaptionContextValue | null>(null);

export function CaptionStreamProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamStatus>({ kind: "idle" });
  const [target, setTarget] = useState<CaptionEvent | null>(null);
  const [native, setNative] = useState<CaptionEvent | null>(null);

  const stream = useMemo(
    () =>
      new CaptionStream({
        onStatusChange: (s) => setStatus(s),
        onActiveChange: (d) => {
          setTarget(d.target);
          setNative(d.native);
        },
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = subscribeToCaptions((payload) => {
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
      }
    });
    return () => {
      unsubscribe();
      restoreYtCaptions();
      stream.stop();
    };
  }, [stream]);

  const value = useMemo<CaptionContextValue>(
    () => ({ status, target, native, stream }),
    [status, target, native, stream],
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
