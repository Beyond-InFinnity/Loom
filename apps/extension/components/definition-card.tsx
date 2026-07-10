import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getApiClient } from "@/lib/api-client";
import { getDefineCapabilities } from "@/lib/annotate/capabilities";
import { t, languageName } from "@/lib/i18n";
import {
  glossLangsForSource,
  normalizeDefineSourceLang,
  resolveGlossLang,
} from "@/lib/annotate/define-lang";
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
  romaji?: string | null;
  romaji_alt?: string | null;
  senses?: DefineSense[];
}

interface DefinitionData {
  word: string;
  found: boolean;
  reading?: string | null;
  /** Hepburn (macrons), Japanese only — Tōkyō. */
  romaji?: string | null;
  /** Hepburn (doubled vowels), Japanese only — Toukyou; absent when equal to
      `romaji` (no long vowel). */
  romaji_alt?: string | null;
  senses?: DefineSense[];
  sources?: string[];
  /** Decomposition breakdown when the word itself isn't a headword
      (e.g. 一顶 → 一 + 顶, 玉葉様 → 様).  Present only when `found` is false. */
  parts?: DefinePart[];
}

type FetchState =
  | { kind: "loading" }
  // "notfound" still carries the response so the header can show the
  // reading + Hepburn even with no dictionary entry.
  | { kind: "ok"; data: DefinitionData }
  | { kind: "notfound"; data?: DefinitionData }
  | { kind: "error" };

interface DefinitionCardProps {
  word: string;
  lemma: string;
  /** Contextual reading of the surface (JA; topic は → わ).  When present it's
      shown in the header in preference to the dictionary reading, so the card
      reflects how the word is actually read in this line. */
  reading?: string | null;
  rect: DOMRect;
  langCode: string | null;
  /** Current dictionary gloss-language override (null = auto).  Threaded from
      the caption context so the in-card picker and the settings-panel line stay
      in sync. */
  glossLangOverride: string | null;
  /** Set the gloss-language override (persists globally); re-fetches the card. */
  onGlossLangChange: (code: string | null) => void;
  onDismiss: () => void;
}

const CARD_MAX_WIDTH = 320;
const CARD_MIN_WIDTH = 200;
const ANCHOR_GAP = 10;
const MAX_SENSES = 4;

export function DefinitionCard({
  word,
  lemma,
  reading,
  rect,
  langCode,
  glossLangOverride,
  onGlossLangChange,
  onDismiss,
}: DefinitionCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Gloss-language picker data, resolved from the server's per-source
  // capabilities in the fetch effect (so the dropdown offers only languages a
  // definition can really be written in for this video's language).
  const [glossOptions, setGlossOptions] = useState<string[]>([]);
  const [activeGloss, setActiveGloss] = useState<string>("en");
  // The card only mounts for a definable track (tokens were present), so the
  // source lang is always valid; the server decides if the specific word hits.
  const sourceLang = useMemo(
    () => normalizeDefineSourceLang(langCode),
    [langCode],
  );

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
    if (!sourceLang) {
      setState({ kind: "notfound" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        // Gloss language follows the user (browser locale / override) among
        // what the server offers, English fallback — so a JA user gets JA
        // definitions once that data exists, with no extension change.
        const caps = await getDefineCapabilities();
        if (cancelled) return;
        // Restrict the override + options to what THIS source language offers.
        const glossLang = resolveGlossLang(caps, glossLangOverride, sourceLang);
        setActiveGloss(glossLang);
        setGlossOptions(glossLangsForSource(caps, sourceLang));
        // Look up the lemma first, then fall back to the surface form: MeCab's
        // lemma is wrong/truncated for some compounds (黒曜石 → lemma 黒曜), and
        // a glued honorific (玉葉様) only decomposes off the surface.  `readings`
        // carries the contextual kana so the server's Hepburn matches the shown
        // furigana (は→わ, inflected 見た).
        const { data, error } = await getApiClient().POST("/define/batch", {
          body: {
            lang: sourceLang,
            gloss_lang: glossLang,
            words: [lemma],
            alt_keys: [[word]],
            readings: [reading ?? ""],
          },
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
          hasContent
            ? { kind: "ok", data: result }
            : { kind: "notfound", data: result },
        );
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceLang, lemma, word, reading, glossLangOverride]);

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
      aria-label={t("define.of", { word })}
    >
      <div style={headerStyle}>
        <span style={wordStyle}>{word}</span>
        <HeaderReading {...readingBits(reading, state)} />
      </div>
      <Body state={state} />
      <Footer
        sources={
          state.kind === "ok" ? state.data.sources ?? null : null
        }
        glossOptions={glossOptions}
        activeGloss={activeGloss}
        onGlossLangChange={onGlossLangChange}
      />
    </div>
  );
}

/** Bottom dark-grey strip: the dictionary citation (left) + the "Dictionary
    language" picker (right).  The picker shows only when the source language
    offers more than one gloss language.  Selecting one sets the global
    override; the card re-fetches with the new gloss language. */
function Footer({
  sources,
  glossOptions,
  activeGloss,
  onGlossLangChange,
}: {
  sources: string[] | null;
  glossOptions: string[];
  activeGloss: string;
  onGlossLangChange: (code: string | null) => void;
}) {
  const showPicker = glossOptions.length > 1;
  const citation =
    sources && sources.length > 0
      ? sources.map((s) => SOURCE_LABELS[s] ?? s).join(" · ")
      : null;
  if (!showPicker && !citation) return null;
  return (
    <div style={footerStyle}>
      {citation ? <span style={sourceStyle}>{citation}</span> : <span />}
      {showPicker ? (
        <label style={glossPickerStyle} title={t("define.glossLanguage")}>
          <span style={glossPickerLabelStyle}>{t("define.glossLanguage")}</span>
          <select
            style={glossSelectStyle}
            value={activeGloss}
            onChange={(e) => onGlossLangChange(e.currentTarget.value)}
          >
            {glossOptions.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/** Furigana + Hepburn for the header.  Furigana = the contextual surface
    reading (topic は → わ) if we have one, else the dictionary reading.  Romaji
    is server-computed (so it can't drift from the caption romaji line) and is
    present for Japanese only. */
function readingBits(
  contextual: string | null | undefined,
  state: FetchState,
): { furigana: string | null; romaji: string | null; romajiAlt: string | null } {
  const data =
    state.kind === "ok" || state.kind === "notfound" ? state.data : undefined;
  return {
    furigana: contextual || data?.reading || null,
    romaji: data?.romaji ?? null,
    romajiAlt: data?.romaji_alt ?? null,
  };
}

/** Renders `furigana • Hepburn (Hepburn-doubled)` — the bullet separates the
    kana reading from the romaji; the parenthetical doubled form is shown only
    when it differs (i.e. the reading has a long vowel: Tōkyō (Toukyou), but
    just Mita). */
function HeaderReading({
  furigana,
  romaji,
  romajiAlt,
}: {
  furigana: string | null;
  romaji: string | null;
  romajiAlt: string | null;
}) {
  if (!furigana && !romaji) return null;
  return (
    <span style={readingStyle}>
      {furigana}
      {romaji ? (
        <>
          {furigana ? <span style={bulletStyle}> • </span> : null}
          <span style={romajiStyle}>
            {romaji}
            {romajiAlt && romajiAlt !== romaji ? ` (${romajiAlt})` : ""}
          </span>
        </>
      ) : null}
    </span>
  );
}

function Body({ state }: { state: FetchState }) {
  if (state.kind === "loading") {
    return <div style={mutedStyle}>{t("define.looking")}</div>;
  }
  if (state.kind === "error") {
    return <div style={mutedStyle}>{t("define.unreachable")}</div>;
  }
  if (state.kind === "notfound") {
    return <div style={mutedStyle}>{t("define.noEntry")}</div>;
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
        <div style={breakdownLabelStyle}>{t("define.breakdown")}</div>
        <div style={breakdownListStyle}>
          {parts.map((p, i) => (
            <div key={i} style={partRowStyle}>
              <span style={partHeadStyle}>
                <span style={partWordStyle}>{p.word}</span>
                {p.reading ? (
                  <span style={readingStyle}>{p.reading}</span>
                ) : null}
                {p.romaji ? (
                  <span style={romajiStyle}>
                    {p.romaji}
                    {p.romaji_alt && p.romaji_alt !== p.romaji
                      ? ` (${p.romaji_alt})`
                      : ""}
                  </span>
                ) : null}
              </span>
              <span style={partGlossStyle}>
                {(p.senses ?? [])
                  .slice(0, 4)
                  .map((s) => s.gloss.join("; "))
                  .join("; ")}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return <div style={mutedStyle}>{t("define.noEntry")}</div>;
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

// Romaji sits a touch dimmer/warmer than the blue furigana so the eye reads
// kana → romaji as one unit split by the bullet.
const romajiStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#d5deea",
};

const bulletStyle: React.CSSProperties = {
  color: "#6f7d90",
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

const footerStyle: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const sourceStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#6f7d90",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const glossPickerStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  flex: "0 0 auto",
};

const glossPickerLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#8ea0b6",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

// Compact native select — robust inside the shadow-root overlay; the page's
// styles don't reach here so we set our own dark look.
const glossSelectStyle: React.CSSProperties = {
  appearance: "auto",
  background: "rgba(255,255,255,0.08)",
  color: "#e6ebf2",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 5,
  fontSize: 11,
  padding: "2px 4px",
  maxWidth: 130,
  cursor: "pointer",
};

// Pretty attribution labels for the dictionary sources (CC-BY-SA attribution).
const SOURCE_LABELS: Record<string, string> = {
  jmdict: "JMdict",
  "cc-cedict": "CC-CEDICT",
  krdict: "KRDict (NIKL)",
  wiktextract: "Wiktionary",
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
