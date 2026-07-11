// The overlay window's entry — the DOM caption stack over the video
// (7c-6, MOBILE_ROADMAP.md §5).  This webview is a DUMB RENDERER: the main
// window's PlayerView computes everything (stream, annotate spans/tokens,
// romanize map, definable gate) and pushes render-ready state via the
// app-wide "loom-overlay-state" Tauri event.  The overlay renders the
// 4-layer stack with true relative ruby positioning (HTML <ruby> via
// AnnotatedText) — the reason .ass could never be the core format — and,
// while paused, makes the target line's words clickable → DefinitionCard,
// ON the video.
//
// Pointer behavior is flipped Rust-side (set_ignore_cursor_events) by the
// PlayerView on pause edges; this page just renders.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";

import "../player/host"; // registers this webview's LoomHost (same origin → shared localStorage)

import { buildRichSegments } from "@loom/player-ui/orthography/build-segments";
import { AnnotatedText } from "@loom/player-ui/components/annotated-text";
import { DefinitionCard } from "@loom/player-ui/components/definition-card";
import { normalizeDefineSourceLang } from "@loom/player-ui/annotate/define-lang";
import type { AnnotateSpan, AnnotateToken } from "@loom/player-ui/annotate/types";

const GLOSS_OVERRIDE_KEY = "loom_dictionary_gloss_lang";

/** Render-ready state pushed by PlayerView. */
interface OverlayState {
  targetText: string | null;
  nativeText: string | null;
  spans: AnnotateSpan[] | null;
  tokens: AnnotateToken[] | null;
  romaji: string | null;
  paused: boolean;
  definable: boolean;
  targetLang: string | null;
}

const EMPTY: OverlayState = {
  targetText: null,
  nativeText: null,
  spans: null,
  tokens: null,
  romaji: null,
  paused: false,
  definable: false,
  targetLang: null,
};

interface CardState {
  word: string;
  lemma: string;
  reading: string | null;
  rect: DOMRect;
}

const TEXT_SHADOW =
  "0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.8), 2px 2px 3px rgba(0,0,0,0.9)";

function OverlayApp() {
  const [state, setState] = useState<OverlayState>(EMPTY);
  const [card, setCard] = useState<CardState | null>(null);
  const [glossOverride, setGlossOverride] = useState<string | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(GLOSS_OVERRIDE_KEY) ?? "null");
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const un = listen<OverlayState>("loom-overlay-state", (e) => {
      setState(e.payload);
      // Any state push that isn't paused clears a stale card (resume,
      // track switch, media swap).
      if (!e.payload.paused) setCard(null);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

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
    state.paused && state.definable && !!state.tokens && state.tokens.length > 0;

  const segments = useMemo(() => {
    if (!state.targetText) return null;
    return buildRichSegments({
      spans: state.spans,
      rawText: state.targetText,
      variantTable: null,
      coalescePlain: !interactive,
    });
  }, [state.targetText, state.spans, interactive]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        pointerEvents: "none",
        fontFamily:
          "'Noto Sans CJK JP', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans KR', sans-serif",
      }}
    >
      {/* Top stack: romaji line above the target line with ruby. */}
      <div style={{ textAlign: "center", paddingTop: "2.5%" }}>
        {state.romaji && (
          <div
            style={{
              color: "#f5f0e8",
              fontSize: 22,
              fontStyle: "italic",
              textShadow: TEXT_SHADOW,
              marginBottom: 10,
            }}
          >
            {state.romaji}
          </div>
        )}
        {segments && (
          <div
            style={{
              color: "#fff",
              fontSize: 38,
              lineHeight: 2.1,
              textShadow: TEXT_SHADOW,
              pointerEvents: interactive ? "auto" : "none",
              whiteSpace: "pre-wrap",
            }}
          >
            <AnnotatedText
              segments={segments}
              baseFontPxScaled={38}
              annotationRatio={0.5}
              color="#ffffff"
              fontFamily="inherit"
              variantColor="#ffffff"
              variantFontFamily="inherit"
              highlightEnabled={false}
              cleanHighlightColor="transparent"
              collapseHighlightColor="transparent"
              tokens={state.tokens}
              interactive={interactive}
              onWordClick={onWordClick}
            />
          </div>
        )}
      </div>

      {/* Bottom: native line. */}
      <div style={{ textAlign: "center", paddingBottom: "3.5%" }}>
        {state.nativeText && (
          <div
            style={{
              color: "#fff",
              fontSize: 34,
              textShadow: TEXT_SHADOW,
              whiteSpace: "pre-wrap",
            }}
          >
            {state.nativeText}
          </div>
        )}
      </div>

      {card && state.targetLang && (
        <div style={{ pointerEvents: "auto" }}>
          <DefinitionCard
            word={card.word}
            lemma={card.lemma}
            reading={card.reading}
            rect={card.rect}
            langCode={normalizeDefineSourceLang(state.targetLang)}
            glossLangOverride={glossOverride}
            onGlossLangChange={onGlossLangChange}
            onDismiss={() => setCard(null)}
          />
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);
