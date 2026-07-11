// Loom Player MVP (7c, MOBILE_ROADMAP.md).
//
// mpv plays the video in its OWN window (Linux embed is blocked — see the
// roadmap doc) and renders Loom's generated 4-layer .ass natively via
// libass; THIS view is the interactive surface: transport, track pickers,
// and — while paused — the current target line with per-word lookup (glow
// → click → definition card), i.e. the gloss function on local .mkv files.
//
// All caption plumbing goes through @loom/player-ui seams: the mpv IPC
// PlayheadSource feeds the package CaptionStream; tracks come from the
// sidecar scan (./tracks.ts); annotate tokens + definitions come from the
// PROD text API exactly like the extension.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import "./host"; // registers the desktop LoomHost (module side effect)

import { CaptionStream } from "@loom/player-ui/captions/stream";
import { autoPick } from "@loom/player-ui/captions/auto-pick";
import { baseLang, isDefinable, normalizeDefineSourceLang } from "@loom/player-ui/annotate/define-lang";
import { getDefineCapabilities } from "@loom/player-ui/annotate/capabilities";
import { buildAnnotateMap } from "@loom/player-ui/annotate/build-map";
import { buildRomanizeMap } from "@loom/player-ui/romanize/build-map";
import type { RomanizeMap } from "@loom/player-ui/romanize/types";
import { buildRichSegments } from "@loom/player-ui/orthography/build-segments";
import { AnnotatedText } from "@loom/player-ui/components/annotated-text";
import { DefinitionCard } from "@loom/player-ui/components/definition-card";
import type { AnnotateResult } from "@loom/player-ui/annotate/types";
import type { CaptionEvent } from "@loom/player-ui/captions/types";

import {
  getMpvState,
  initMpvEvents,
  mpvPlayhead,
  onMpvState,
  seekToMs,
  setPause,
  startMpv,
  stopMpv,
} from "./mpv";
import { fetchTrackEvents, loadMedia, type LoadedMedia } from "./tracks";

const GLOSS_OVERRIDE_KEY = "loom_dictionary_gloss_lang";

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

function readGlossOverride(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(GLOSS_OVERRIDE_KEY) ?? "null");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function PlayerView() {
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  const [glossOverride, setGlossOverride] = useState<string | null>(readGlossOverride);

  const streamRef = useRef<CaptionStream | null>(null);
  if (!streamRef.current) {
    streamRef.current = new CaptionStream();
  }

  // mpv event plumbing: transport snapshot + paused edge + playhead ticks.
  useEffect(() => {
    void initMpvEvents();
    const offState = onMpvState(() => setMpvState(getMpvState()));
    const offPause = mpvPlayhead.onPausedChange((p) => {
      setPaused(p);
      if (!p) setCard(null); // resuming playback dismisses the card
    });
    return () => {
      offState();
      offPause();
      void stopMpv();
      void streamRef.current?.stop();
      void invoke("close_player_windows").catch(() => {});
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

  const userLang = useMemo(() => baseLang(navigator.language), []);

  const pickFile = useCallback(async () => {
    setError(null);
    const picked = await open({
      multiple: false,
      filters: [
        {
          name: "Video",
          extensions: ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"],
        },
      ],
    });
    if (typeof picked !== "string") return;

    setBusy("Starting playback…");
    setMedia(null);
    setTargetId(null);
    setNativeId(null);
    setAnnotate(null);
    setRomanize(null);
    setCard(null);
    try {
      // Dual-window architecture (MOBILE_ROADMAP.md §5): mpv renders into
      // the Loom-owned video window (--wid); the transparent overlay
      // window above it carries the DOM caption stack.  Playback starts
      // immediately; scanning runs while the first frames roll.
      const xid = await invoke<number>("setup_player_windows");
      await startMpv(picked, xid);
      setBusy("Scanning subtitle tracks…");
      const loaded = await loadMedia(picked);
      setMedia(loaded);
      const picks = autoPick(
        loaded.tracks.map((t) => t.caption),
        userLang,
      );
      setTargetId(picks.target?.id ?? loaded.tracks[0]?.caption.id ?? null);
      setNativeId(picks.native?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [userLang]);

  const targetTrack = useMemo(
    () => media?.tracks.find((t) => t.caption.id === targetId) ?? null,
    [media, targetId],
  );
  const nativeTrack = useMemo(
    () => media?.tracks.find((t) => t.caption.id === nativeId) ?? null,
    [media, nativeId],
  );
  const targetLang = targetTrack?.caption.languageCode ?? null;

  // Definable gate for the interactive line (capability-driven, same as
  // the extension).
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

  // Track selection → events + stream + annotate tokens + Loom subs.
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

        // Annotate spans+tokens (ruby + word grouping) and the romaji line
        // fetch in the background; the overlay renders plain text until
        // they land.  Same batch endpoints/cadence as the extension.
        const texts = targetEvents.map((e) => e.text);
        const lang = targetTrack.caption.languageCode;
        void buildAnnotateMap(texts, { langCode: lang }).then((result) => {
          if (!cancelled) setAnnotate(result);
        });
        void buildRomanizeMap(texts, { langCode: lang }).then((result) => {
          if (!cancelled) setRomanize(result);
        });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [media, targetTrack, nativeTrack]);

  // Push render-ready state to the overlay window (dumb renderer) on every
  // cue / pause / data-map change.  Cue changes are ~one per 2-4s; maps land
  // once per track — trivial event volume.
  useEffect(() => {
    const text = currentTarget?.text.trim() ?? null;
    void emit("loom-overlay-state", {
      targetText: currentTarget?.text ?? null,
      nativeText: currentNative?.text ?? null,
      spans: text ? annotate?.spans.get(text) ?? null : null,
      tokens: text ? annotate?.tokens.get(text) ?? null : null,
      romaji: text ? romanize?.get(text) ?? null : null,
      paused,
      definable,
      targetLang,
    }).catch(() => {});
  }, [currentTarget, currentNative, annotate, romanize, paused, definable, targetLang]);

  // Pointer flip: the overlay is click-through while playing, interactive
  // on pause (words clickable ON the video).
  useEffect(() => {
    void invoke("set_overlay_interactive", { interactive: paused }).catch(
      () => {},
    );
  }, [paused]);

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

  // The paused line, word-grouped when tokens are available.
  const pausedLine = useMemo(() => {
    if (!paused || !currentTarget) return null;
    const text = currentTarget.text.trim();
    const tokens = annotate?.tokens.get(text) ?? null;
    const spans = annotate?.spans.get(text) ?? null;
    const interactive = definable && !!tokens && tokens.length > 0;
    const segments = buildRichSegments({
      spans,
      rawText: text,
      variantTable: null,
      coalescePlain: !interactive,
    });
    return { text, tokens, segments, interactive };
  }, [paused, currentTarget, annotate, definable]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={() => void pickFile()}>Open video…</button>
        {media && (
          <span style={{ opacity: 0.85 }}>
            {media.metadata.title ?? media.path.split("/").pop()}
            {media.metadata.year ? ` (${media.metadata.year})` : ""}
          </span>
        )}
        {busy && <span style={{ opacity: 0.7 }}>{busy}</span>}
      </div>

      {error && (
        <div style={{ color: "#f66" }}>
          {error}
        </div>
      )}

      {media && (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button onClick={() => void setPause(!mpvState.paused)}>
              {mpvState.paused ? "▶ Play" : "⏸ Pause"}
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
          </div>

          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <label>
              Video language{" "}
              <select
                value={targetId ?? ""}
                onChange={(e) => setTargetId(e.target.value || null)}
              >
                {media.tracks.map((t) => (
                  <option key={t.caption.id} value={t.caption.id}>
                    {t.caption.name} ({t.caption.languageCode})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Your language{" "}
              <select
                value={nativeId ?? ""}
                onChange={(e) => setNativeId(e.target.value || null)}
              >
                <option value="">—</option>
                {media.tracks.map((t) => (
                  <option key={t.caption.id} value={t.caption.id}>
                    {t.caption.name} ({t.caption.languageCode})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            style={{
              minHeight: 120,
              borderRadius: 8,
              padding: 16,
              background: "rgba(255,255,255,0.04)",
              position: "relative",
            }}
          >
            {pausedLine ? (
              <div style={{ fontSize: 26, lineHeight: 1.9 }}>
                <AnnotatedText
                  segments={pausedLine.segments}
                  baseFontPxScaled={26}
                  annotationRatio={0.5}
                  color="#f5f0e8"
                  fontFamily="'Noto Sans JP', 'Noto Sans SC', 'Noto Sans KR', sans-serif"
                  variantColor="#f5f0e8"
                  variantFontFamily="inherit"
                  highlightEnabled={false}
                  cleanHighlightColor="transparent"
                  collapseHighlightColor="transparent"
                  tokens={pausedLine.tokens}
                  interactive={pausedLine.interactive}
                  onWordClick={onWordClick}
                />
                {currentNative && (
                  <div style={{ fontSize: 15, opacity: 0.65, marginTop: 8 }}>
                    {currentNative.text}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ opacity: 0.5, fontSize: 14 }}>
                {paused
                  ? "No subtitle at the playhead."
                  : "Pause the video to look up words in the current line."}
              </div>
            )}

            {card && targetLang && (
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
            )}
          </div>
        </>
      )}

      {!media && !busy && (
        <p style={{ opacity: 0.6 }}>
          Open a local video file — mpv plays it in its own window with
          Loom&apos;s dual-subtitle stack, and this window becomes your
          dictionary: pause anytime and click a word.
        </p>
      )}
    </div>
  );
}
