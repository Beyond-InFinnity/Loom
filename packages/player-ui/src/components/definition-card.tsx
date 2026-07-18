import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getApiClient } from "../api-client";
import { loomHost } from "../host";
import { getDefineCapabilities } from "../annotate/capabilities";
import { t, languageName } from "../i18n";
import {
  glossLangsForSource,
  normalizeDefineSourceLang,
  resolveGlossLang,
} from "../annotate/define-lang";
import { swallowPlayerEvents } from "../overlay/stop-player-events";

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

interface GrammarFeature {
  code: string;
  /** English label; shown as-is (client localizes known codes later). */
  display: string;
  surface?: string;
}

interface GrammarBreakdown {
  dict_form: string;
  features: GrammarFeature[];
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
  /** Grammar breakdown of the inflected surface (Japanese): dictionary form +
      ordered inflection features.  Present only when there's inflection. */
  grammar?: GrammarBreakdown | null;
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

// Base (scale = 1) width so horizontal centering under the word can't shift as
// content loads (a variable width was half of the "bounce").  Actual width =
// CARD_WIDTH * scale (uniform resize — see the scale plumbing below).
const CARD_WIDTH = 300;
const BASE_FONT_PX = 14; // the card's root font-size at scale 1
const ANCHOR_GAP = 10;
// Cap the card to this fraction of the viewport height (it also can't exceed
// the room on its chosen side — see placeDefinitionCard).
const CARD_MAX_HEIGHT_FRAC = 0.6;
const MAX_SENSES = 4;
// Uniform-resize bounds + the resize grip.  SCALE_MAX is only a sanity
// ceiling — the reachability guardrail is viewportMaxScale() (the card can't
// grow past the screen width), so this can be generous.
const SCALE_MIN = 0.85;
const SCALE_MAX = 3.5;
const CARD_SCALE_KEY = "loom_def_card_scale";
const RESIZE_GRIP_PX = 15;

// Every size in the card is written as `sz(px)` = `calc(<px> * var(--loom-def-
// scale))`, and the card root sets `--loom-def-scale` to the current scale.
// So ONE root variable uniformly scales the whole card — width, fonts,
// padding, gaps, ruby, grammar pills — preserving its shape, crisply (a CSS
// custom property, unlike nested `em`, never compounds; unlike transform:scale
// it re-rasterizes text sharp).  Letter-spacing (em) and unitless line-heights
// already scale with font-size, so they stay as-is.
function sz(px: number): string {
  return `calc(${px}px * var(--loom-def-scale))`;
}

// ---- persisted uniform card scale -------------------------------------------
// The user's chosen size sticks across words + sessions + host (extension and
// desktop Player) via the storage seam.  A module-level cache is read
// SYNCHRONOUSLY in the useState initializer (the card remounts on every word,
// and an async storage.get would flash at the default size first) — the same
// pattern as caption-context's per-platform prefs.  loomHost() is only touched
// at runtime (never at module top level), so importing this file for the pure
// helpers/tests never requires a registered host.
let cachedCardScale = 1;
let cardScaleLoaded = false;
const cardScaleListeners = new Set<() => void>();

function ensureCardScaleLoaded(): void {
  if (cardScaleLoaded) return;
  cardScaleLoaded = true;
  loomHost()
    .storage.get(CARD_SCALE_KEY)
    .then((r) => {
      const v = (r as Record<string, unknown>)?.[CARD_SCALE_KEY];
      if (typeof v === "number" && Number.isFinite(v)) {
        cachedCardScale = clamp(v, SCALE_MIN, SCALE_MAX);
        cardScaleListeners.forEach((f) => f());
      }
    })
    .catch(() => {});
}

function persistCardScale(s: number): void {
  cachedCardScale = s;
  loomHost().storage.set({ [CARD_SCALE_KEY]: s }).catch(() => {});
}

/** New uniform scale from a resize-grip drag.  `dx`/`dy` are pointer deltas
    since drag start; `signX`/`signY` are the grip corner's growth direction.
    The two axes are averaged so a diagonal pull grows the card while the
    ASPECT is preserved (one scale drives box + text together).  Pure +
    exported for tests. */
export function nextCardScale(args: {
  startScale: number;
  dx: number;
  dy: number;
  signX: number;
  signY: number;
  baseWidth: number;
  /** Upper bound (default SCALE_MAX).  Callers pass the viewport-fit cap so a
      drag can't push the card wider than the screen (grip off the edge). */
  maxScale?: number;
}): number {
  const { startScale, dx, dy, signX, signY, baseWidth } = args;
  const grow = (dx * signX + dy * signY) / 2; // px along the grip's diagonal
  const hi = Math.min(SCALE_MAX, args.maxScale ?? SCALE_MAX);
  return clamp((startScale * baseWidth + grow) / baseWidth, SCALE_MIN, hi);
}

/** The largest scale that keeps the card within the viewport width (so the
    right-edge grip stays reachable) — used to cap both the drag and, when a
    size persisted on a wide screen is reopened on a narrow player, the render.
    Falls back to SCALE_MAX when there's no window (never in the browser). */
function viewportMaxScale(margin = 8): number {
  const vw = typeof window !== "undefined" ? window.innerWidth : Infinity;
  return clamp((vw - 2 * margin) / CARD_WIDTH, SCALE_MIN, SCALE_MAX);
}

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
  const [pos, setPos] = useState<CardPos | null>(null);
  // Uniform, persisted card scale (drag the corner grip).  Read synchronously
  // from the module cache so a remounted card opens at the user's size with no
  // default-size flash; the effect below picks up an async storage load.
  const [scale, setScale] = useState<number>(() => {
    ensureCardScaleLoaded();
    return cachedCardScale;
  });
  useEffect(() => {
    const sync = () => setScale(cachedCardScale);
    cardScaleListeners.add(sync);
    return () => {
      cardScaleListeners.delete(sync);
    };
  }, []);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startScale: number;
    signY: number;
    latest: number;
  } | null>(null);
  // Cap the RENDERED scale to what fits the viewport width, so a size the user
  // set on a wide screen (persisted) can't open the card wider than a narrow
  // player and push the right-edge grip off-screen.  The persisted intent
  // (`scale`) is preserved; only rendering is capped.
  const renderScale = Math.min(scale, viewportMaxScale());
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
  // position:absolute + transform:translateZ(0) (perf tripwire), so it — not
  // the viewport — is the containing block.  We measure the containing block
  // DIRECTLY via `offsetParent` (position-independent): the old code inferred
  // the origin from the card's OWN rect while it sat at (0,0), but that origin
  // is only valid on the first pass — once the card is positioned, re-measuring
  // it yields the card's current spot, not the origin, and subtracting that
  // flung the card toward the top-left corner (the reported bug).  Placement is
  // now a pure function of the WORD rect (not the card's own height), anchored
  // by the edge nearest the word, so the skeleton lands exactly where the
  // loaded card will and never bounces as content fills in.  useLayoutEffect
  // runs before paint → the card is placed before it's ever shown.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const parent = card.offsetParent as HTMLElement | null;
    const cb = parent
      ? parent.getBoundingClientRect()
      : { left: 0, top: 0, bottom: window.innerHeight };
    setPos(
      placeDefinitionCard({
        word: rect,
        container: { left: cb.left, top: cb.top, bottom: cb.bottom },
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        cardWidth: CARD_WIDTH * renderScale, // scaled width → correct centering + clamp
        gap: ANCHOR_GAP,
      }),
    );
  }, [rect, renderScale]);

  // Resize grip: sits in the corner AWAY from the word (so the card grows away
  // from it), drives a uniform scale, persists on release.  signY encodes which
  // corner — bottom when the card is below the word, top when above.
  const gripAtBottom = !pos || pos.top !== undefined;
  const onGripDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startScale: scale,
      signY: gripAtBottom ? 1 : -1,
      latest: scale,
    };
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const ns = nextCardScale({
      startScale: d.startScale,
      dx: e.clientX - d.startX,
      dy: e.clientY - d.startY,
      signX: 1,
      signY: d.signY,
      baseWidth: CARD_WIDTH,
      maxScale: viewportMaxScale(), // don't let the card grow past the screen
    });
    d.latest = ns;
    setScale(ns);
  };
  const onGripUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    persistCardScale(d.latest);
  };

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
            surfaces: [word],
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
      style={cardOuterStyle(pos, renderScale)}
      {...swallowPlayerEvents}
      role="dialog"
      aria-label={t("define.of", { word })}
    >
      <style>{SCROLLBAR_CSS}</style>
      <div className="loom-def-scroll" style={cardInnerStyle(pos)}>
        <div style={headerStyle}>
          <span style={wordStyle}>{word}</span>
          <HeaderReading {...readingBits(reading, state)} />
        </div>
        {(state.kind === "ok" || state.kind === "notfound") &&
        state.data?.grammar ? (
          <GrammarSection grammar={state.data.grammar} />
        ) : null}
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
      {pos ? (
        <div
          style={gripStyle(gripAtBottom)}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          // A drag on the grip must not select text or reach the player.
          onMouseDown={(e) => e.preventDefault()}
        />
      ) : null}
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

/** Grammar breakdown: the dictionary form followed by the inflection chain it
    was run through (食べる → causative → passive → past).  Feature labels are the
    server's English `display` for now; the `code` is carried for later
    localization.  `surface` (the morpheme) is a hover title. */
function GrammarSection({ grammar }: { grammar: GrammarBreakdown }) {
  return (
    <div style={grammarSectionStyle}>
      <div style={grammarLabelStyle}>{t("define.grammar")}</div>
      <div style={grammarChainStyle}>
        <span style={grammarDictFormStyle}>{grammar.dict_form}</span>
        {grammar.features.map((f, i) => (
          <Fragment key={i}>
            <span style={grammarArrowStyle} aria-hidden="true">
              →
            </span>
            <span style={grammarFeatureStyle} title={f.surface || undefined}>
              {f.display}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
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
/** Card placement in containing-block coordinates.  Anchored by the edge
    NEAREST the word — `top` when placed below (grows downward), `bottom` when
    placed above (grows upward) — so the near edge never moves as content
    loads.  `maxHeight` caps it to the room on the chosen side so a tall
    result scrolls internally instead of running off-screen. */
export interface CardPos {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Pure placement math (exported for unit tests).  Height-INDEPENDENT: the
    result depends only on the clicked WORD's viewport rect + the containing
    block, never on the card's own size — so the loading skeleton and the
    fully-loaded card share one position and the card cannot bounce.  Places
    on whichever side of the word has more room (subtitles sit low → usually
    above), centers horizontally under the word (clamped on-screen), and
    anchors the edge nearest the word. */
export function placeDefinitionCard(args: {
  word: { left: number; right: number; top: number; bottom: number; width: number };
  container: { left: number; top: number; bottom: number };
  viewportWidth: number;
  viewportHeight: number;
  cardWidth: number;
  gap: number;
  margin?: number;
}): CardPos {
  const {
    word,
    container,
    viewportWidth: vw,
    viewportHeight: vh,
    cardWidth: W,
    gap,
  } = args;
  const margin = args.margin ?? 8;
  const centerX = word.left + word.width / 2;
  const vpLeft = clamp(centerX - W / 2, margin, Math.max(margin, vw - W - margin));
  const left = Math.round(vpLeft - container.left);
  const hardMax = Math.round(vh * CARD_MAX_HEIGHT_FRAC);
  const roomAbove = word.top - gap - margin;
  const roomBelow = vh - word.bottom - gap - margin;
  const cap = (room: number) => Math.max(0, Math.min(Math.round(room), hardMax));
  if (roomAbove > roomBelow) {
    // Card's BOTTOM edge sits `gap` above the word; it grows upward.
    return {
      left,
      bottom: Math.round(container.bottom - (word.top - gap)),
      maxHeight: cap(roomAbove),
    };
  }
  // Card's TOP edge sits `gap` below the word; it grows downward.
  return {
    left,
    top: Math.round(word.bottom + gap - container.top),
    maxHeight: cap(roomBelow),
  };
}

// The card is TWO boxes: an OUTER positioning frame (placed near the word,
// holds the resize grip) wrapping an INNER scrolling box (the visible card —
// background, border, padding, content).  Splitting them keeps the grip pinned
// to the visible corner even when a large-scaled card's content scrolls: an
// absolutely-positioned grip inside the scroll box would ride the content out
// of view.  maxHeight lives on the INNER box; the outer wraps it tightly.
function cardOuterStyle(pos: CardPos | null, scale: number): React.CSSProperties {
  const style: React.CSSProperties = {
    position: "absolute",
    left: pos ? pos.left : 0,
    top: pos ? pos.top ?? "auto" : 0,
    bottom: pos ? pos.bottom ?? "auto" : "auto",
    visibility: pos ? "visible" : "hidden",
    zIndex: 2147483647,
    width: sz(CARD_WIDTH),
    pointerEvents: "auto",
    filter: `drop-shadow(0 ${sz(6)} ${sz(24)} rgba(0,0,0,0.5))`,
    // Own compositor layer.
    transform: "translateZ(0)",
    willChange: "transform",
    contain: "layout paint style",
  };
  // The one lever the whole card scales off — every sz() reads this custom
  // property.  Set via a cast: this @types/react's CSSProperties has no
  // `--*` index signature.
  (style as Record<string, string>)["--loom-def-scale"] = String(scale);
  return style;
}

function cardInnerStyle(pos: CardPos | null): React.CSSProperties {
  return {
    maxHeight: pos ? pos.maxHeight : Math.round(600 * CARD_MAX_HEIGHT_FRAC),
    overflowY: "auto",
    boxSizing: "border-box",
    padding: `${sz(10)} ${sz(12)}`,
    borderRadius: sz(8),
    // Solid background — NO backdrop-filter (perf tripwire).
    background: "rgba(20, 22, 28, 0.97)",
    color: "#f2f4f8",
    border: "1px solid rgba(255,255,255,0.14)",
    fontFamily: "system-ui, -apple-system, 'Noto Sans', sans-serif",
    fontWeight: 400,
    fontSize: sz(BASE_FONT_PX),
    lineHeight: 1.4,
    textAlign: "left",
    // Thin subtle scrollbar (only appears on a scaled-up / long card) so a
    // classic Linux/Windows scrollbar doesn't clash with the corner grip.
    // Firefox honours these; Chromium is styled via SCROLLBAR_CSS below.
    scrollbarWidth: "thin",
    scrollbarColor: "rgba(255,255,255,0.28) transparent",
    // Selectable so users can copy readings / glosses out (e.g. into Google
    // Translate).  The site's `user-select: none` inherits into the shadow
    // overlay otherwise; the click-swallow on the outer keeps a drag-select
    // from reaching the player, and the outside-click dismiss fires on a
    // mousedown that starts INSIDE the card, so selecting never dismisses it.
    userSelect: "text",
    WebkitUserSelect: "text",
    cursor: "text",
  };
}

// Chromium scrollbar styling (the `scrollbar*` props above cover Firefox).
// Scoped to the card's scroll box so it never touches the host page.
const SCROLLBAR_CSS = `
.loom-def-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.loom-def-scroll::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.28); border-radius: 8px;
}
.loom-def-scroll::-webkit-scrollbar-track { background: transparent; }
`;

/** The OS-style diagonal resize grip, in the corner away from the word. */
function gripStyle(atBottom: boolean): React.CSSProperties {
  return {
    position: "absolute",
    right: sz(3),
    [atBottom ? "bottom" : "top"]: sz(3),
    width: sz(RESIZE_GRIP_PX),
    height: sz(RESIZE_GRIP_PX),
    cursor: atBottom ? "nwse-resize" : "nesw-resize",
    // Two faint diagonal hatch lines, mirrored for the top-corner variant.
    // Stops scale with the grip so the hatch density stays constant.
    backgroundImage: `repeating-linear-gradient(${
      atBottom ? "-45deg" : "45deg"
    }, transparent 0 ${sz(2)}, rgba(255,255,255,0.4) ${sz(2)} ${sz(3)})`,
    backgroundPosition: atBottom ? "bottom right" : "top right",
    backgroundRepeat: "no-repeat",
    backgroundSize: "70% 70%",
    opacity: 0.55,
    borderRadius: sz(2),
    touchAction: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
  };
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: sz(8),
  marginBottom: sz(6),
  paddingBottom: sz(6),
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const wordStyle: React.CSSProperties = {
  fontSize: sz(20),
  fontWeight: 600,
  lineHeight: 1.1,
};

const readingStyle: React.CSSProperties = {
  fontSize: sz(13),
  color: "#9fd0ff",
};

// Romaji sits a touch dimmer/warmer than the blue furigana so the eye reads
// kana → romaji as one unit split by the bullet.
const romajiStyle: React.CSSProperties = {
  fontSize: sz(13),
  color: "#d5deea",
};

const bulletStyle: React.CSSProperties = {
  color: "#6f7d90",
};

const senseListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: sz(18),
  display: "flex",
  flexDirection: "column",
  gap: sz(4),
};

const senseItemStyle: React.CSSProperties = {
  lineHeight: 1.35,
};

const posStyle: React.CSSProperties = {
  display: "inline-block",
  marginRight: sz(6),
  fontSize: sz(11),
  color: "#8ea0b6",
  fontStyle: "italic",
};

const mutedStyle: React.CSSProperties = {
  color: "#aab4c2",
  fontSize: sz(13),
};

const grammarSectionStyle: React.CSSProperties = {
  marginBottom: sz(6),
  paddingBottom: sz(6),
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const grammarLabelStyle: React.CSSProperties = {
  fontSize: sz(10),
  color: "#8ea0b6",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: sz(3),
};

const grammarChainStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: `${sz(3)} ${sz(5)}`,
  lineHeight: 1.3,
};

const grammarDictFormStyle: React.CSSProperties = {
  fontSize: sz(14),
  fontWeight: 600,
  color: "#e6ebf2",
};

const grammarArrowStyle: React.CSSProperties = {
  fontSize: sz(11),
  color: "#6f7d90",
};

// Each inflection step as a subtle pill so the chain reads as discrete features.
const grammarFeatureStyle: React.CSSProperties = {
  fontSize: sz(11),
  color: "#bcd2ea",
  background: "rgba(120,150,190,0.16)",
  border: "1px solid rgba(140,170,210,0.22)",
  borderRadius: sz(4),
  padding: `${sz(1)} ${sz(6)}`,
  whiteSpace: "nowrap",
};

const footerStyle: React.CSSProperties = {
  marginTop: sz(8),
  paddingTop: sz(6),
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: sz(8),
};

const sourceStyle: React.CSSProperties = {
  fontSize: sz(10),
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
  gap: sz(5),
  flex: "0 0 auto",
};

const glossPickerLabelStyle: React.CSSProperties = {
  fontSize: sz(10),
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
  borderRadius: sz(5),
  fontSize: sz(11),
  padding: `${sz(2)} ${sz(4)}`,
  maxWidth: sz(130),
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
  fontSize: sz(10),
  color: "#8ea0b6",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: sz(5),
};

const breakdownListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: sz(6),
};

const partRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: sz(1),
  lineHeight: 1.3,
};

const partHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: sz(6),
};

const partWordStyle: React.CSSProperties = {
  fontSize: sz(17),
  fontWeight: 600,
};

const partGlossStyle: React.CSSProperties = {
  fontSize: sz(13),
  color: "#d6dde6",
};
