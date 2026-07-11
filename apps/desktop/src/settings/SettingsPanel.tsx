// Loom Player settings — the desktop (Tauri main-window) settings UI,
// styled to match the browser-extension settings panel.  Writes the shared
// store (host.ts); the player window reads the same keys and re-renders its
// subtitles live.  Isolated from the extension (no caption-context import).
//
// Prioritized sections (Connor): Presets, Layout/Position, Phonetic +
// toggles, plus the per-layer colors presets drive.

import { useEffect, useState } from "react";
import { fetchPresetCatalog } from "@loom/player-ui/presets/fetch";
import type { Preset, PresetCatalog } from "@loom/player-ui/presets/types";
import { phoneticSystemsFor } from "@loom/player-ui/captions/lang-support";
import {
  applyLayerColors,
  useSetting,
  type CaptionPosition,
  type LongVowelMode,
} from "./model";

// Study language this panel configures for (presets + phonetic systems).
// Matches the player's STUDY_LANG; a picker is a future addition.
const STUDY_LANG = "ja";

const C = {
  panelBg: "#14120f",
  card: "rgba(255,255,255,0.05)",
  cardBorder: "rgba(255,255,255,0.09)",
  text: "#efe9dd",
  dim: "#a49b88",
  accent: "#b98bff",
  gold: "#d9b45a",
};

export function SettingsPanel() {
  return (
    <div
      style={{
        background: C.panelBg,
        color: C.text,
        borderRadius: 12,
        padding: 16,
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 460,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.3 }}>
        Player subtitle settings
      </div>
      <div style={{ color: C.dim, marginTop: -8, fontSize: 12 }}>
        Changes apply live to the player window.
      </div>

      <Presets />
      <LayoutSection />
      <PhoneticSection />
      <LayerSection
        title="Top (video language)"
        colorName="topColor"
        sizeName="topFontSizePx"
        alphaName="topAlpha"
        outlineColorName="topOutlineColor"
        outlineAlphaName="topOutlineAlpha"
        glowRadiusName="topGlowRadius"
        glowColorName="topGlowColor"
        glowAlphaName="topGlowAlpha"
        enabledName="topLineEnabled"
      />
      <LayerSection
        title="Bottom (your language)"
        colorName="bottomColor"
        sizeName="bottomFontSizePx"
        alphaName="bottomAlpha"
        outlineColorName="bottomOutlineColor"
        outlineAlphaName="bottomOutlineAlpha"
        glowRadiusName="bottomGlowRadius"
        glowColorName="bottomGlowColor"
        glowAlphaName="bottomGlowAlpha"
        enabledName="bottomLineEnabled"
      />
      <LayerSection
        title="Annotation (furigana / ruby)"
        colorName="annotationColor"
        alphaName="annotationAlpha"
        outlineColorName="annotationOutlineColor"
        outlineAlphaName="annotationOutlineAlpha"
        glowRadiusName="annotationGlowRadius"
        glowColorName="annotationGlowColor"
        glowAlphaName="annotationGlowAlpha"
      />
    </div>
  );
}

// ---- Presets ------------------------------------------------------------
function Presets() {
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [activeId, setActiveId] = useSetting("activePresetId");

  useEffect(() => {
    let cancelled = false;
    void fetchPresetCatalog({ lang: STUDY_LANG }).then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = (p: Preset) => {
    setActiveId(p.id);
    void applyLayerColors({
      top: p.layers.Top?.color,
      bottom: p.layers.Bottom?.color,
      annotation: p.layers.Annotation?.color,
      romanization: p.layers.Romanized?.color,
    });
  };

  return (
    <Card title="Color presets">
      {!catalog ? (
        <div style={{ color: C.dim }}>Loading…</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 8,
          }}
        >
          {catalog.presets.map((p) => {
            const active = p.id === activeId;
            return (
              <button
                key={p.id}
                onClick={() => apply(p)}
                title={p.description}
                style={{
                  border: `1px solid ${active ? C.accent : C.cardBorder}`,
                  borderRadius: 8,
                  background: "rgba(0,0,0,0.35)",
                  padding: "6px 8px",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                <div style={{ display: "flex", gap: 3 }}>
                  {["Top", "Bottom", "Annotation"].map((l) => (
                    <span
                      key={l}
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 3,
                        background: p.layers[l]?.color ?? "transparent",
                        border: "1px solid rgba(255,255,255,0.2)",
                      }}
                    />
                  ))}
                </div>
                <span style={{ fontSize: 11, color: C.text, textAlign: "left" }}>
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---- Layout / Position --------------------------------------------------
const POSITIONS: { value: CaptionPosition; label: string }[] = [
  { value: "top-1", label: "Top ①" },
  { value: "top-2", label: "Top ②" },
  { value: "bottom-1", label: "Bottom ①" },
  { value: "bottom-2", label: "Bottom ②" },
];

function LayoutSection() {
  const [target, setTarget] = useSetting("targetPosition");
  const [nativePos, setNativePos] = useSetting("nativePosition");
  const [size, setSize] = useSetting("captionSizePct");
  const [spacing, setSpacing] = useSetting("lineSpacingPx");
  const [topNudge, setTopNudge] = useSetting("topPositionOffsetPct");
  const [botNudge, setBotNudge] = useSetting("bottomPositionOffsetPct");

  return (
    <Card title="Layout & position">
      <SlotPicker label="Video line" value={target} onChange={setTarget} />
      <SlotPicker label="Your line" value={nativePos} onChange={setNativePos} />
      <Slider label="Subtitle size" value={size} min={50} max={150} suffix="%" onChange={setSize} />
      <Slider label="Line spacing" value={spacing} min={-10} max={40} suffix="px" onChange={setSpacing} />
      <Slider label="Top nudge" value={topNudge} min={-40} max={40} suffix="%" onChange={setTopNudge} />
      <Slider label="Bottom nudge" value={botNudge} min={-40} max={40} suffix="%" onChange={setBotNudge} />
    </Card>
  );
}

function SlotPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CaptionPosition;
  onChange: (v: CaptionPosition) => void;
}) {
  return (
    <Row label={label}>
      <div style={{ display: "flex", gap: 4 }}>
        {POSITIONS.map((p) => (
          <button
            key={p.value}
            onClick={() => onChange(p.value)}
            style={{
              padding: "3px 7px",
              fontSize: 11,
              borderRadius: 6,
              cursor: "pointer",
              border: `1px solid ${value === p.value ? C.accent : C.cardBorder}`,
              background: value === p.value ? "rgba(185,139,255,0.18)" : "transparent",
              color: C.text,
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

// ---- Phonetic + toggles -------------------------------------------------
function PhoneticSection() {
  const [annotate, setAnnotate] = useSetting("targetAnnotateEnabled");
  const [romanize, setRomanize] = useSetting("targetRomanizeEnabled");
  const [phonetic, setPhonetic] = useSetting("targetPhoneticSystem");
  const [longVowel, setLongVowel] = useSetting("longVowelMode");

  const systems = phoneticSystemsFor(STUDY_LANG);

  return (
    <Card title="Reading aids">
      <Row label="Per-character annotation">
        <Switch on={annotate} onToggle={() => setAnnotate(!annotate)} />
      </Row>
      <Row label="Romanization line">
        <Switch on={romanize} onToggle={() => setRomanize(!romanize)} />
      </Row>
      {systems.length > 1 && (
        <Row label="Phonetic system">
          <select
            value={phonetic ?? systems[0]?.code ?? ""}
            onChange={(e) => setPhonetic(e.target.value)}
            style={selectStyle}
          >
            {systems.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </Row>
      )}
      {STUDY_LANG === "ja" && (
        <Row label="Long vowels (romaji)">
          <select
            value={longVowel}
            onChange={(e) => setLongVowel(e.target.value as LongVowelMode)}
            style={selectStyle}
          >
            <option value="macrons">Macrons (ō)</option>
            <option value="doubled">Doubled (ou)</option>
            <option value="unmarked">Unmarked (o)</option>
          </select>
        </Row>
      )}
    </Card>
  );
}

// ---- Per-layer styling --------------------------------------------------
interface LayerSectionProps {
  title: string;
  colorName: Parameters<typeof useSetting>[0];
  sizeName?: Parameters<typeof useSetting>[0];
  alphaName: Parameters<typeof useSetting>[0];
  outlineColorName: Parameters<typeof useSetting>[0];
  outlineAlphaName: Parameters<typeof useSetting>[0];
  glowRadiusName: Parameters<typeof useSetting>[0];
  glowColorName: Parameters<typeof useSetting>[0];
  glowAlphaName: Parameters<typeof useSetting>[0];
  enabledName?: Parameters<typeof useSetting>[0];
}

function LayerSection(props: LayerSectionProps) {
  const [color, setColor] = useSetting(props.colorName) as [string, (v: string) => void];
  const [alpha, setAlpha] = useSetting(props.alphaName) as [number, (v: number) => void];
  const [outlineColor, setOutlineColor] = useSetting(props.outlineColorName) as [string, (v: string) => void];
  const [outlineAlpha, setOutlineAlpha] = useSetting(props.outlineAlphaName) as [number, (v: number) => void];
  const [glowRadius, setGlowRadius] = useSetting(props.glowRadiusName) as [number, (v: number) => void];
  const [glowColor, setGlowColor] = useSetting(props.glowColorName) as [string, (v: string) => void];
  const [glowAlpha, setGlowAlpha] = useSetting(props.glowAlphaName) as [number, (v: number) => void];
  const size = props.sizeName ? (useSetting(props.sizeName) as [number, (v: number) => void]) : null;
  const enabled = props.enabledName ? (useSetting(props.enabledName) as [boolean, (v: boolean) => void]) : null;

  return (
    <Card
      title={props.title}
      right={enabled ? <Switch on={enabled[0]} onToggle={() => enabled[1](!enabled[0])} /> : undefined}
    >
      <Row label="Color">
        <ColorSwatch value={color} onChange={setColor} />
      </Row>
      {size && (
        <Slider label="Size" value={size[0]} min={16} max={80} suffix="px" onChange={size[1]} />
      )}
      <Slider label="Opacity" value={alpha} min={0} max={100} suffix="%" onChange={setAlpha} />
      <Row label="Outline">
        <ColorSwatch value={outlineColor} onChange={setOutlineColor} />
      </Row>
      <Slider label="Outline opacity" value={outlineAlpha} min={0} max={100} suffix="%" onChange={setOutlineAlpha} />
      <Slider label="Glow radius" value={glowRadius} min={0} max={20} suffix="px" onChange={setGlowRadius} />
      {glowRadius > 0 && (
        <>
          <Row label="Glow color">
            <ColorSwatch value={glowColor} onChange={setGlowColor} />
          </Row>
          <Slider label="Glow opacity" value={glowAlpha} min={0} max={100} suffix="%" onChange={setGlowAlpha} />
        </>
      )}
    </Card>
  );
}

// ---- shared bits --------------------------------------------------------
const selectStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.4)",
  color: C.text,
  border: `1px solid ${C.cardBorder}`,
  borderRadius: 6,
  padding: "3px 6px",
  fontSize: 12,
};

function Card({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.cardBorder}`,
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 600, color: C.gold, fontSize: 12.5 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: C.dim }}>{label}</span>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Row label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, maxWidth: 220 }}>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {value}
          {suffix}
        </span>
      </div>
    </Row>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        cursor: "pointer",
        background: on ? C.accent : "rgba(255,255,255,0.14)",
        position: "relative",
        transition: "background 0.15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: on ? "#fff" : C.gold,
          transition: "left 0.15s",
        }}
      />
    </button>
  );
}

function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: value,
          border: "1px solid rgba(255,255,255,0.25)",
        }}
      />
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
      />
      <span style={{ fontSize: 11, color: C.dim, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </label>
  );
}
