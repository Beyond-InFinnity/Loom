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

import { initDesktopStorage } from "../player/host"; // registers the desktop LoomHost

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
  isMutedPersisted,
  setAudioLang,
  setMute,
  setPause,
  startMpv,
  stopMpv,
} from "../player/mpv";
import {
  audioLangAliases,
  fetchTrackEvents,
  loadMedia,
  selectStudyTracks,
  type LoadedMedia,
} from "../player/tracks";
import { usePlayerStyles } from "../settings/model";

// The language the user is studying (Top line + furigana/romaji + audio).
// Persisted; default Japanese.  (A picker for this is a future setting.)
const STUDY_LANG =
  localStorage.getItem("loom_player_study_lang") || "ja";

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
  // Muted by default; the SOURCE OF TRUTH is the engine's persisted pref
  // (player_is_muted), seeded on mount.  The engine also starts muted at the
  // mpv-option level before any audio can play — this state just mirrors it
  // and drives the toolbar toggle.  Safe default true until the seed lands.
  const [muted, setMuted] = useState<boolean>(true);

  // Settings-driven styles from the shared store (adjusted in the main
  // window's SettingsPanel; live across windows).
  const styles = usePlayerStyles();

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

  // Seed the toggle from the engine's persisted truth once attached.
  useEffect(() => {
    if (attached) void isMutedPersisted().then(setMuted);
  }, [attached]);

  // Apply + persist mute whenever it changes or a new file loads (the engine
  // already starts muted; this keeps it in sync after user toggles / loads).
  useEffect(() => {
    if (attached) void setMute(muted);
  }, [muted, attached, media]);

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
      // Prefer the study language (JA) for Top + the user's language for
      // Bottom; fall back to generic auto-pick when neither is present.
      const study = selectStudyTracks(loaded.tracks, STUDY_LANG, userLang);
      const fallback = autoPick(loaded.tracks.map((t) => t.caption), userLang);
      setTargetId(
        study.targetId ?? fallback.target?.id ?? loaded.tracks[0]?.caption.id ?? null,
      );
      setNativeId(study.nativeId ?? fallback.native?.id ?? null);
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
        const lang = targetTrack.caption.languageCode;
        // Play the audio in the language being studied (matches the Top
        // subs) — multi-dub files list English first, so we pick explicitly.
        void setAudioLang(audioLangAliases(lang));
        const texts = targetEvents.map((e) => e.text);
        // Phonetic system: the user's setting wins; else pinyin for
        // Traditional Chinese (Zhuyin deprecated); else the engine default.
        const phoneticSystem =
          styles.phoneticSystem ?? (lang === "zh-Hant" ? "pinyin" : undefined);
        void buildAnnotateMap(texts, { langCode: lang, phoneticSystem }).then(
          (r) => {
            if (!cancelled) setAnnotate(r);
          },
        );
        void buildRomanizeMap(texts, {
          langCode: lang,
          phoneticSystem,
          longVowelMode: styles.longVowelMode,
        }).then((r) => {
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
  }, [media, targetTrack, nativeTrack, styles.phoneticSystem, styles.longVowelMode]);

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

  // Annotation toggle: when off, strip ruby (spans) but keep word grouping
  // for the gloss (tokens still drive the clickable words).
  const renderSpans = styles.annotateEnabled ? spans : null;
  const segments = useMemo(() => {
    const text = currentTarget?.text.trim();
    if (!text) return null;
    return buildRichSegments({
      spans: renderSpans,
      rawText: text,
      variantTable: null,
      coalescePlain: !wordInteractive,
    });
  }, [currentTarget, renderSpans, wordInteractive]);

  const scale = styles.captionScale;
  const showRomaji = styles.romanizeEnabled && romaji;

  // Target (Top) + native (Bottom) render into their configured slots.
  const targetAtTop = styles.topSlot.startsWith("top");
  const nativeAtTop = styles.nativeSlot.startsWith("top");

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
        <button
          onClick={() => setMuted((m) => !m)}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? "🔇" : "🔊"}
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

      {/* Caption zones (top / bottom) — target + native render into their
          configured slots, styled from the shared settings. */}
      {(() => {
        const targetBlock = styles.topLineEnabled && segments && (
          <div style={{ textAlign: "center" }}>
            {showRomaji && (
              <div
                style={{
                  color: styles.romanization.color,
                  opacity: styles.romanization.opacity,
                  fontSize: styles.topFontSizePx * styles.romanizationFontRatio * scale,
                  fontStyle: "italic",
                  textShadow: styles.romanization.shadow,
                  marginBottom: 6,
                }}
              >
                {romaji}
              </div>
            )}
            <div
              style={{
                color: styles.annotation.color,
                fontSize: styles.topFontSizePx * scale,
                lineHeight: 2.1,
                textShadow: styles.top.shadow,
                opacity: styles.top.opacity,
                pointerEvents: wordInteractive ? "auto" : "none",
                whiteSpace: "pre-wrap",
              }}
            >
              <AnnotatedText
                segments={segments}
                baseFontPxScaled={styles.topFontSizePx * scale}
                annotationRatio={styles.annotationFontRatio}
                color={styles.top.color}
                fontFamily="'Noto Sans CJK JP','Noto Sans JP','Noto Sans SC','Noto Sans KR',sans-serif"
                variantColor={styles.top.color}
                variantFontFamily="inherit"
                highlightEnabled={false}
                cleanHighlightColor="transparent"
                collapseHighlightColor="transparent"
                tokens={tokens}
                interactive={wordInteractive}
                onWordClick={onWordClick}
              />
            </div>
          </div>
        );
        const nativeBlock = styles.bottomLineEnabled && currentNative && (
          <div
            style={{
              textAlign: "center",
              color: styles.bottom.color,
              opacity: styles.bottom.opacity,
              fontSize: styles.bottomFontSizePx * scale,
              textShadow: styles.bottom.shadow,
              whiteSpace: "pre-wrap",
              marginTop: styles.lineSpacingPx,
            }}
          >
            {currentNative.text}
          </div>
        );
        return (
          <div
            style={{
              flex: 1,
              position: "relative",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              padding: "2.5% 4% 3.5%",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: styles.lineSpacingPx }}>
              {targetAtTop && targetBlock}
              {nativeAtTop && nativeBlock}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: styles.lineSpacingPx }}>
              {!targetAtTop && targetBlock}
              {!nativeAtTop && nativeBlock}
            </div>
          </div>
        );
      })()}

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
void initDesktopStorage().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(<PlayerWindow />);
});
