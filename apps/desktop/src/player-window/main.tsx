// Loom Player — single integrated window (MOBILE_ROADMAP.md §5a).
//
// One transparent Tauri window: libmpv renders the video into a GtkGLArea
// BEHIND this webview (reparented Rust-side by player_attach); this DOM is
// the caption stack (romaji + ruby Top + native Bottom) + transport bar +
// pause-gloss definition card, painted over the video.  VLC-style: video,
// captions, and controls in one window.
//
// All caption plumbing is the shared @loom/player-ui seam stack; the mpv
// render engine feeds the PlayheadSource via "mpv-prop" events (src/player/
// mpv.ts), identical to the old IPC path — the UI never knew which engine
// draws the pixels.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { open } from "@tauri-apps/plugin-dialog";

import "../player/host"; // registers the desktop LoomHost

import { CaptionStream } from "@loom/player-ui/captions/stream";
import { autoPick } from "@loom/player-ui/captions/auto-pick";
import {
  isDefinable,
  normalizeDefineSourceLang,
} from "@loom/player-ui/annotate/define-lang";
import { getDefineCapabilities } from "@loom/player-ui/annotate/capabilities";
import { buildAnnotateMap } from "@loom/player-ui/annotate/build-map";
import { buildRomanizeMap } from "@loom/player-ui/romanize/build-map";
import { buildRichSegments } from "@loom/player-ui/orthography/build-segments";
import { AnnotatedText } from "@loom/player-ui/components/annotated-text";
import { DefinitionCard } from "@loom/player-ui/components/definition-card";
import type { AnnotateResult } from "@loom/player-ui/annotate/types";
import type { RomanizeMap } from "@loom/player-ui/romanize/types";
import type { CaptionEvent } from "@loom/player-ui/captions/types";

import {
  attachPlayer,
  getMpvState,
  initMpvEvents,
  mpvPlayhead,
  onMpvState,
  seekToMs,
  setPause,
  startMpv,
  stopMpv,
} from "../player/mpv";
import {
  fetchTrackEvents,
  loadMedia,
  type LoadedMedia,
} from "../player/tracks";

const GLOSS_OVERRIDE_KEY = "loom_dictionary_gloss_lang";
const TEXT_SHADOW =
  "0 0 3px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85), 2px 2px 3px rgba(0,0,0,0.9)";

interface CardState {
  word: string;
  lemma: string;
  reading: string | null;
  rect: DOMRect;
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function readGloss(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(GLOSS_OVERRIDE_KEY) ?? "null");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function PlayerWindow() {
  const [attached, setAttached] = useState(false);
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [nativeId, setNativeId] = useState<string | null>(null);
  const [annotate, setAnnotate] = useState<AnnotateResult | null>(null);
  const [romanize, setRomanize] = useState<RomanizeMap | null>(null);
  const [currentTarget, setCurrentTarget] = useState<CaptionEvent | null>(null);
  const [currentNative, setCurrentNative] = useState<CaptionEvent | null>(null);
  const [paused, setPaused] = useState(false);
  const [mpvState, setMpvState] = useState(getMpvState());
  const [card, setCard] = useState<CardState | null>(null);
  const [definable, setDefinable] = useState(false);
  const [glossOverride, setGlossOverride] = useState<string | null>(readGloss);

  const streamRef = useRef<CaptionStream | null>(null);
  if (!streamRef.current) streamRef.current = new CaptionStream();

  // Attach the video surface + wire mpv events, once.
  useEffect(() => {
    void (async () => {
      try {
        await attachPlayer();
        await initMpvEvents();
        setAttached(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    const offState = onMpvState(() => setMpvState(getMpvState()));
    const offPause = mpvPlayhead.onPausedChange((p) => {
      setPaused(p);
      if (!p) setCard(null);
    });
    return () => {
      offState();
      offPause();
      void stopMpv();
      void streamRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    streamRef.current?.setCallbacks({
      onActiveChange: (d) => {
        setCurrentTarget(d.target);
        setCurrentNative(d.native);
      },
    });
  }, []);

  const userLang = useMemo(
    () => navigator.language.split("-")[0].toLowerCase(),
    [],
  );

  const loadPath = useCallback(async (picked: string) => {
    setError(null);
    setBusy("Starting playback…");
    setMedia(null);
    setTargetId(null);
    setNativeId(null);
    setAnnotate(null);
    setRomanize(null);
    setCard(null);
    try {
      await startMpv(picked);
      setBusy("Scanning subtitle tracks…");
      const loaded = await loadMedia(picked);
      setMedia(loaded);
      const picks = autoPick(loaded.tracks.map((t) => t.caption), userLang);
      setTargetId(picks.target?.id ?? loaded.tracks[0]?.caption.id ?? null);
      setNativeId(picks.native?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [userLang]);

  const pickFile = useCallback(async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Video", extensions: ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"] },
      ],
    });
    if (typeof picked === "string") await loadPath(picked);
  }, [loadPath]);

  const targetTrack = useMemo(
    () => media?.tracks.find((t) => t.caption.id === targetId) ?? null,
    [media, targetId],
  );
  const nativeTrack = useMemo(
    () => media?.tracks.find((t) => t.caption.id === nativeId) ?? null,
    [media, nativeId],
  );
  const targetLang = targetTrack?.caption.languageCode ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!targetLang) {
      setDefinable(false);
      return;
    }
    getDefineCapabilities().then((caps) => {
      if (!cancelled) setDefinable(isDefinable(caps, targetLang));
    });
    return () => {
      cancelled = true;
    };
  }, [targetLang]);

  // Track selection → events + stream + annotate/romanize maps.
  useEffect(() => {
    if (!media || !targetTrack) return;
    let cancelled = false;
    const stream = streamRef.current!;
    (async () => {
      try {
        setBusy("Loading captions…");
        const [targetEvents, nativeEvents] = await Promise.all([
          fetchTrackEvents(targetTrack),
          nativeTrack ? fetchTrackEvents(nativeTrack) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        await stream.start({
          targetEvents,
          nativeEvents,
          targetLang: targetTrack.caption.languageCode,
          nativeLang: nativeTrack?.caption.languageCode ?? "",
        });
        const texts = targetEvents.map((e) => e.text);
        const lang = targetTrack.caption.languageCode;
        void buildAnnotateMap(texts, { langCode: lang }).then((r) => {
          if (!cancelled) setAnnotate(r);
        });
        void buildRomanizeMap(texts, { langCode: lang }).then((r) => {
          if (!cancelled) setRomanize(r);
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [media, targetTrack, nativeTrack]);

  const onGlossLangChange = useCallback((code: string | null) => {
    setGlossOverride(code);
    localStorage.setItem(GLOSS_OVERRIDE_KEY, JSON.stringify(code));
  }, []);

  const onWordClick = useCallback(
    (word: string, lemma: string, reading: string | null, rect: DOMRect) => {
      setCard({ word, lemma, reading, rect });
    },
    [],
  );

  const interactive =
    paused && definable && !!currentTarget;
  const pausedText = paused ? currentTarget?.text.trim() ?? null : null;
  const romaji = currentTarget
    ? romanize?.get(currentTarget.text.trim()) ?? null
    : null;
  const tokens = pausedText ? annotate?.tokens.get(pausedText) ?? null : null;
  const spans = currentTarget
    ? annotate?.spans.get(currentTarget.text.trim()) ?? null
    : null;
  const wordInteractive = interactive && !!tokens && tokens.length > 0;

  const segments = useMemo(() => {
    const text = currentTarget?.text.trim();
    if (!text) return null;
    return buildRichSegments({
      spans,
      rawText: text,
      variantTable: null,
      coalescePlain: !wordInteractive,
    });
  }, [currentTarget, spans, wordInteractive]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        pointerEvents: "none",
      }}
    >
      {/* Top toolbar (interactive). */}
      <div
        style={{
          pointerEvents: "auto",
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "8px 12px",
          background: "rgba(0,0,0,0.45)",
          color: "#fff",
          fontSize: 13,
        }}
      >
        <button onClick={() => void pickFile()} disabled={!attached}>
          Open video…
        </button>
        {media && (
          <>
            <button onClick={() => void setPause(!mpvState.paused)}>
              {mpvState.paused ? "▶" : "⏸"}
            </button>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtTime(mpvState.timeMs)} / {fmtTime(mpvState.durationMs)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(1, mpvState.durationMs)}
              value={Math.min(mpvState.timeMs, mpvState.durationMs)}
              onChange={(e) => void seekToMs(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <select
              value={targetId ?? ""}
              onChange={(e) => setTargetId(e.target.value || null)}
              title="Video language"
            >
              {media.tracks.map((t) => (
                <option key={t.caption.id} value={t.caption.id}>
                  {t.caption.languageCode}
                </option>
              ))}
            </select>
            <select
              value={nativeId ?? ""}
              onChange={(e) => setNativeId(e.target.value || null)}
              title="Your language"
            >
              <option value="">—</option>
              {media.tracks.map((t) => (
                <option key={t.caption.id} value={t.caption.id}>
                  {t.caption.languageCode}
                </option>
              ))}
            </select>
          </>
        )}
        {busy && <span style={{ opacity: 0.8 }}>{busy}</span>}
        {error && <span style={{ color: "#f88" }}>{error}</span>}
      </div>

      {/* Caption stack over the video. */}
      <div
        style={{
          textAlign: "center",
          paddingBottom: "3.5%",
          position: "relative",
        }}
      >
        {romaji && (
          <div
            style={{
              color: "#f5f0e8",
              fontSize: 22,
              fontStyle: "italic",
              textShadow: TEXT_SHADOW,
              marginBottom: 8,
            }}
          >
            {romaji}
          </div>
        )}
        {segments && (
          <div
            style={{
              color: "#fff",
              fontSize: 38,
              lineHeight: 2.1,
              textShadow: TEXT_SHADOW,
              pointerEvents: wordInteractive ? "auto" : "none",
              whiteSpace: "pre-wrap",
            }}
          >
            <AnnotatedText
              segments={segments}
              baseFontPxScaled={38}
              annotationRatio={0.5}
              color="#ffffff"
              fontFamily="'Noto Sans CJK JP','Noto Sans JP','Noto Sans SC','Noto Sans KR',sans-serif"
              variantColor="#ffffff"
              variantFontFamily="inherit"
              highlightEnabled={false}
              cleanHighlightColor="transparent"
              collapseHighlightColor="transparent"
              tokens={tokens}
              interactive={wordInteractive}
              onWordClick={onWordClick}
            />
          </div>
        )}
        {currentNative && (
          <div
            style={{
              color: "#fff",
              fontSize: 30,
              textShadow: TEXT_SHADOW,
              marginTop: 8,
              whiteSpace: "pre-wrap",
            }}
          >
            {currentNative.text}
          </div>
        )}
      </div>

      {card && targetLang && (
        <div style={{ pointerEvents: "auto" }}>
          <DefinitionCard
            word={card.word}
            lemma={card.lemma}
            reading={card.reading}
            rect={card.rect}
            langCode={normalizeDefineSourceLang(targetLang)}
            glossLangOverride={glossOverride}
            onGlossLangChange={onGlossLangChange}
            onDismiss={() => setCard(null)}
          />
        </div>
      )}
    </div>
  );
}

// NO React.StrictMode here: it double-invokes effects on mount, and this
// window's mount effect owns NATIVE resources (the libmpv handle + render
// context via player_attach/stopMpv).  A double mount→unmount→mount would
// terminate mpv mid-setup and race commands on the freed handle (segfault
// in mpv_command).  The main launcher window keeps StrictMode; this one
// can't.
ReactDOM.createRoot(document.getElementById("root")!).render(<PlayerWindow />);
