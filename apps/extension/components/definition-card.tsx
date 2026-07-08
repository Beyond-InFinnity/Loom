import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getApiClient } from "@/lib/api-client";
import { defineLangFor } from "@/lib/annotate/define-lang";
import { swallowPlayerEvents } from "@/lib/overlay/stop-player-events";

// DefinitionCard — the per-word vocab-lookup popup (VOCAB_LOOKUP.md Phase 2).
//
// Mounted by CaptionOverlay only while the video is PAUSED and a word has
// been clicked.  Fetches POST /define/batch for the word's dictionary lemma
// and shows its reading + senses, anchored to the clicked word's rect.
//
// Perf: no backdrop-filter (CLAUDE.md tripwire) — solid rgba background on
// its own compositor layer.  Only ever alive while paused, so it never
// touches the playback-time render path.

interface DefineSense {
  gloss: string[];
  pos?: string[];
  misc?: string[];
}

interface DefinePart {
  word: string;
  reading?: string | null;
  senses?: DefineSense[];
}

interface DefinitionData {
  word: string;
  found: boolean;
  reading?: string | null;
  senses?: DefineSense[];
  sources?: string[];
  /** Decomposition breakdown when the word itself isn't a headword
      (e.g. 一顶 → 一 + 顶).  Present only when `found` is false. */
  parts?: DefinePart[];
}

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; data: DefinitionData }
  | { kind: "notfound" }
  | { kind: "error" };

interface DefinitionCardProps {
  word: string;
  lemma: string;
  rect: DOMRect;
  langCode: string | null;
  onDismiss: () => void;
}

const CARD_MAX_WIDTH = 320;
const CARD_MIN_WIDTH = 200;
const ANCHOR_GAP = 10;
const MAX_SENSES = 4;

export function DefinitionCard({
  word,
  lemma,
  rect,
  langCode,
  onDismiss,
}: DefinitionCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const defineLang = useMemo(() => defineLangFor(langCode), [langCode]);

  // Position the card relative to its containing block.  The overlay root is
  // transform:translateZ(0) (perf tripwire), so it — not the viewport — is
  // the containing block for our position:absolute.  We first render the card
  // at (0,0); its viewport rect then reveals the containing-block origin, and
  // its measured size lets us clamp/flip against the actual viewport so the
  // card always stays on screen.  useLayoutEffect runs before paint → no
  // visible jump.  Re-measures when the content (height) settles via `state`.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const originRect = card.getBoundingClientRect(); // card is at left:0/top:0
    const ox = originRect.left;
    const oy = originRect.top;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const centerX = rect.left + rect.width / 2;
    const vpLeft = clamp(centerX - cw / 2, 8, Math.max(8, vw - cw - 8));
    const placeAbove = rect.top > vh / 2;
    const vpTop = clamp(
      placeAbove ? rect.top - ANCHOR_GAP - ch : rect.bottom + ANCHOR_GAP,
      8,
      Math.max(8, vh - ch - 8),
    );
    setPos({ top: Math.round(vpTop - oy), left: Math.round(vpLeft - ox) });
  }, [rect, state]);

  // Fetch the definition for this lemma.
  useEffect(() => {
    if (!defineLang) {
      setState({ kind: "notfound" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const { data, error } = await getApiClient().POST("/define/batch", {
          body: { lang: defineLang, words: [lemma] },
        });
        if (cancelled) return;
        if (
          error ||
          !data ||
          !Array.isArray(data.results) ||
          data.results.length === 0
        ) {
          setState({ kind: "error" });
          return;
        }
        const result = data.results[0] as DefinitionData;
        // "ok" covers both a direct hit AND a decomposition breakdown (found
        // false but parts present, e.g. 一顶 → 一 + 顶).
        const hasContent =
          result.found || (result.parts?.length ?? 0) > 0;
        setState(
          hasContent ? { kind: "ok", data: result } : { kind: "notfound" },
        );
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defineLang, lemma]);

  // Dismiss on Escape or a click outside the card.  composedPath() pierces
  // the shadow boundary (the overlay lives in a shadow root), so the
  // outside-click test works across it — same idea as the settings panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onDown = (e: MouseEvent) => {
      const el = cardRef.current;
      if (el && !e.composedPath().includes(el)) onDismiss();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onDismiss]);

  return (
    <div
      ref={cardRef}
      style={cardStyle(pos)}
      {...swallowPlayerEvents}
      role="dialog"
      aria-label={`Definition of ${word}`}
    >
      <div style={headerStyle}>
        <span style={wordStyle}>{word}</span>
        {state.kind === "ok" && state.data.reading ? (
          <span style={readingStyle}>{state.data.reading}</span>
        ) : null}
      </div>
      <Body state={state} />
      {state.kind === "ok" &&
      state.data.sources &&
      state.data.sources.length > 0 ? (
        <div style={sourceStyle}>{state.data.sources.join(" · ")}</div>
      ) : null}
    </div>
  );
}

function Body({ state }: { state: FetchState }) {
  if (state.kind === "loading") {
    return <div style={mutedStyle}>Looking up…</div>;
  }
  if (state.kind === "error") {
    return <div style={mutedStyle}>Couldn’t reach the dictionary.</div>;
  }
  if (state.kind === "notfound") {
    return <div style={mutedStyle}>No dictionary entry.</div>;
  }
  const senses = (state.data.senses ?? []).slice(0, MAX_SENSES);
  if (senses.length > 0) {
    return (
      <ol style={senseListStyle}>
        {senses.map((s, i) => (
          <li key={i} style={senseItemStyle}>
            {s.pos && s.pos.length > 0 ? (
              <span style={posStyle}>{s.pos.join(", ")}</span>
            ) : null}
            <span>{s.gloss.join("; ")}</span>
          </li>
        ))}
      </ol>
    );
  }
  // No direct entry — show the decomposition breakdown if we have one
  // (jieba grouped e.g. a number + measure word into one clickable token).
  const parts = state.data.parts ?? [];
  if (parts.length > 0) {
    return (
      <div>
        <div style={breakdownLabelStyle}>Breakdown</div>
        <div style={breakdownListStyle}>
          {parts.map((p, i) => (
            <div key={i} style={partRowStyle}>
              <span style={partHeadStyle}>
                <span style={partWordStyle}>{p.word}</span>
                {p.reading ? (
                  <span style={readingStyle}>{p.reading}</span>
                ) : null}
              </span>
              <span style={partGlossStyle}>
                {(p.senses?.[0]?.gloss ?? []).join("; ")}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return <div style={mutedStyle}>No dictionary entry.</div>;
}

// ---- positioning + styles --------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Static card style + the measured position.  `pos` is in containing-block
    coordinates (see the useLayoutEffect); until measured the card renders at
    (0,0) hidden so it can be sized without a visible flash. */
function cardStyle(
  pos: { top: number; left: number } | null,
): React.CSSProperties {
  return {
    position: "absolute",
    left: pos ? pos.left : 0,
    top: pos ? pos.top : 0,
    visibility: pos ? "visible" : "hidden",
    zIndex: 2147483647,
    minWidth: CARD_MIN_WIDTH,
    maxWidth: CARD_MAX_WIDTH,
    maxHeight: "50vh",
    overflowY: "auto",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 8,
    // Solid background — NO backdrop-filter (perf tripwire).
    background: "rgba(20, 22, 28, 0.97)",
    color: "#f2f4f8",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
    font: "400 14px/1.4 system-ui, -apple-system, 'Noto Sans', sans-serif",
    textAlign: "left",
    pointerEvents: "auto",
    // Own compositor layer.
    transform: "translateZ(0)",
    willChange: "transform",
    contain: "layout paint style",
  };
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  marginBottom: 6,
  paddingBottom: 6,
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const wordStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  lineHeight: 1.1,
};

const readingStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#9fd0ff",
};

const senseListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const senseItemStyle: React.CSSProperties = {
  lineHeight: 1.35,
};

const posStyle: React.CSSProperties = {
  display: "inline-block",
  marginRight: 6,
  fontSize: 11,
  color: "#8ea0b6",
  fontStyle: "italic",
};

const mutedStyle: React.CSSProperties = {
  color: "#aab4c2",
  fontSize: 13,
};

const sourceStyle: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.08)",
  fontSize: 10,
  color: "#6f7d90",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const breakdownLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#8ea0b6",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 5,
};

const breakdownListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const partRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  lineHeight: 1.3,
};

const partHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
};

const partWordStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
};

const partGlossStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#d6dde6",
};
