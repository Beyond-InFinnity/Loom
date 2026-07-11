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

import "./host"; // registers the desktop LoomHost (module side effect)

import { CaptionStream } from "@loom/player-ui/captions/stream";
import { autoPick } from "@loom/player-ui/captions/auto-pick";
import { baseLang, isDefinable, normalizeDefineSourceLang } from "@loom/player-ui/annotate/define-lang";
import { getDefineCapabilities } from "@loom/player-ui/annotate/capabilities";
import { buildAnnotateMap } from "@loom/player-ui/annotate/build-map";
import { buildRichSegments } from "@loom/player-ui/orthography/build-segments";
import { AnnotatedText } from "@loom/player-ui/components/annotated-text";
import { DefinitionCard } from "@loom/player-ui/components/definition-card";
import type { AnnotateResult } from "@loom/player-ui/annotate/types";
import type { CaptionEvent } from "@loom/player-ui/captions/types";

import { fetchLanguageConfig, generateAss, type GenerateAssResponse } from "../api";
import { defaultStyleConfig, phoneticOptions, type StyleConfig } from "../styles";
import {
  addLoomSubs,
  getMpvState,
  initMpvEvents,
  mpvCommand,
  mpvPlayhead,
  onMpvState,
  seekToMs,
  setPause,
  startMpv,
  stopMpv,
} from "./mpv";
import { fetchTrackEvents, fileUrl, loadMedia, type LoadedMedia } from "./tracks";

const GLOSS_OVERRIDE_KEY = "loom_dictionary_gloss_lang";

/** Language-aware generation styles — the same defaults the generator UI
    applies on track selection (App.tsx lang-defaults effect): annotation
    layer on/off per language (the desktop factory default is OFF — this is
    why furigana was missing from the player's first frames), the language's
    default font on Top/Annotation, and its first phonetic system.  Fail-soft
    to the factory config if the sidecar lookup hiccups. */
async function playerStyleConfig(targetLang: string): Promise<StyleConfig> {
  const cfg = defaultStyleConfig();
  try {
    const meta = await fetchLanguageConfig(targetLang);
    cfg.annotation.enabled = meta.annotation_default_enabled;
    cfg.top.fontname = meta.default_font;
    cfg.annotation.fontname = meta.default_font;
    const opts = phoneticOptions(targetLang);
    cfg.annotation.phonetic_system = opts.length ? opts[0].value : null;
  } catch {
    // Non-fatal: factory defaults still produce a valid 3-layer file.
  }
  return cfg;
}

type SubsStatus =
  | { kind: "none" }
  | { kind: "generating" }
  | { kind: "loom" }
  | { kind: "raw-fallback"; message: string };

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
  const [subsStatus, setSubsStatus] = useState<SubsStatus>({ kind: "none" });
  const [annotate, setAnnotate] = useState<AnnotateResult | null>(null);
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
    setSubsStatus({ kind: "none" });
    setCard(null);
    try {
      // Playback starts immediately; scanning runs while the first frames
      // roll.
      await startMpv(picked);
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

        // Annotate tokens (word grouping for the gloss) fetch in the
        // background; the line renders plain until they land.
        void buildAnnotateMap(
          targetEvents.map((e) => e.text),
          { langCode: targetTrack.caption.languageCode },
        ).then((result) => {
          if (!cancelled) setAnnotate(result);
        });

        // Loom 4-layer .ass into mpv.  Needs BOTH sides; single-track
        // media falls back to the raw extracted target track (mpv renders
        // it natively — still styled by libass defaults).
        await mpvCommand(["sub-remove"]).catch(() => {});
        if (nativeTrack) {
          setSubsStatus({ kind: "generating" });
          try {
            const styles = await playerStyleConfig(
              targetTrack.caption.languageCode,
            );
            if (cancelled) return;
            const res: GenerateAssResponse = await generateAss({
              native_file_id: nativeTrack.info.file_id!,
              target_file_id: targetTrack.info.file_id!,
              target_lang_code: targetTrack.caption.languageCode,
              styles,
              include_annotations: true,
              opt_in_training: false,
            });
            if (cancelled) return;
            await addLoomSubs(fileUrl(res.file_id));
            setSubsStatus({ kind: "loom" });
          } catch (e) {
            if (cancelled) return;
            await addLoomSubs(fileUrl(targetTrack.info.file_id!));
            setSubsStatus({
              kind: "raw-fallback",
              message: e instanceof Error ? e.message : String(e),
            });
          }
        } else {
          await addLoomSubs(fileUrl(targetTrack.info.file_id!));
          setSubsStatus({
            kind: "raw-fallback",
            message: "no native-language track — showing the original track",
          });
        }
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
            <span style={{ opacity: 0.7 }}>
              {subsStatus.kind === "generating" && "Generating Loom subtitles…"}
              {subsStatus.kind === "loom" && "Loom 4-layer subtitles on"}
              {subsStatus.kind === "raw-fallback" &&
                `Original track (${subsStatus.message})`}
            </span>
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
