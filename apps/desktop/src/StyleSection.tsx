import { useEffect, useMemo, useState } from "react";
import {
  applyPreset,
  fetchFonts,
  fetchPresets,
  FontList,
  isJapanese,
  LAYER_KEYS,
  LAYER_LABEL,
  LAYER_WIRE,
  LayerKey,
  LayerStyle,
  LongVowelMode,
  LONG_VOWEL_MODES,
  PhoneticOption,
  phoneticOptions,
  PhoneticSystem,
  Preset,
  PresetCatalog,
  StyleConfig,
} from "./styles";

type ViewMode = "layer" | "property";
const VIEW_KEY = "loom.styleView";

type Props = {
  styles: StyleConfig;
  setStyles: (next: StyleConfig | ((s: StyleConfig) => StyleConfig)) => void;
  targetLang: string;
};

function loadView(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "property" ? "property" : "layer";
}

export function StyleSection({ styles, setStyles, targetLang }: Props) {
  const [view, setView] = useState<ViewMode>(loadView);
  const [fonts, setFonts] = useState<FontList | null>(null);
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [activePresetId, setActivePresetId] = useState<string>("");

  useEffect(() => {
    fetchFonts().then(setFonts).catch(() => setFonts({ all: ["Arial"], cjk: [] }));
  }, []);

  useEffect(() => {
    fetchPresets(targetLang).then(setCatalog).catch(() => setCatalog(null));
    setActivePresetId("");
  }, [targetLang]);

  function changeView(next: ViewMode) {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  }

  function applyPresetById(id: string) {
    setActivePresetId(id);
    if (!id || !catalog) return;
    const preset = catalog.presets.find((p) => p.id === id);
    if (!preset) return;
    setStyles((s) => applyPreset(s, preset));
  }

  return (
    <section
      style={{
        marginTop: 16,
        padding: 16,
        border: "1px solid #333",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <strong>Style</strong>
        <ViewToggle view={view} onChange={changeView} />
      </div>

      {catalog && (
        <PresetBar
          catalog={catalog}
          activeId={activePresetId}
          onChange={applyPresetById}
          targetLang={targetLang}
        />
      )}

      {fonts && (
        <>
          {view === "layer" ? (
            <LayerView
              styles={styles}
              setStyles={setStyles}
              fonts={fonts}
              targetLang={targetLang}
            />
          ) : (
            <PropertyView
              styles={styles}
              setStyles={setStyles}
              fonts={fonts}
              targetLang={targetLang}
            />
          )}
          <StackPositionBlock styles={styles} setStyles={setStyles} />
        </>
      )}
    </section>
  );
}

// ── View toggle ──────────────────────────────────────────────────────

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const opts: { id: ViewMode; label: string }[] = [
    { id: "layer", label: "By layer" },
    { id: "property", label: "By property" },
  ];
  return (
    <div style={{ display: "inline-flex", border: "1px solid #444", borderRadius: 6, overflow: "hidden" }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            padding: "4px 10px",
            fontSize: "0.85em",
            background: view === o.id ? "#444" : "transparent",
            color: view === o.id ? "#fff" : "#bbb",
            border: "none",
            borderRadius: 0,
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Preset bar ───────────────────────────────────────────────────────

type PresetBarProps = {
  catalog: PresetCatalog;
  activeId: string;
  onChange: (id: string) => void;
  targetLang: string;
};

function PresetBar({ catalog, activeId, onChange, targetLang }: PresetBarProps) {
  const grouped = useMemo(() => {
    const m: Record<string, Preset[]> = {};
    for (const p of catalog.presets) (m[p.group] ||= []).push(p);
    return m;
  }, [catalog]);

  const swatches = useMemo(() => {
    const p = catalog.presets.find((p) => p.id === activeId);
    if (!p) return null;
    return LAYER_KEYS.map((k) => ({
      key: k,
      color: p.layers[LAYER_WIRE[k]]?.color ?? "#888888",
    }));
  }, [activeId, catalog]);

  return (
    <div style={{ marginBottom: 14, display: "flex", gap: 12, alignItems: "center" }}>
      <label style={{ fontSize: "0.85em", opacity: 0.75 }}>
        Color preset
        {targetLang && (
          <span style={{ opacity: 0.5, marginLeft: 6 }}>· {targetLang}</span>
        )}
      </label>
      <select
        value={activeId}
        onChange={(e) => onChange(e.target.value)}
        style={{ padding: "4px 8px", fontSize: "0.9em", flex: 1, maxWidth: 320 }}
      >
        <option value="">— No preset (manual) —</option>
        {catalog.groups.map((g) => {
          const list = grouped[g.key] || [];
          if (list.length === 0) return null;
          return (
            <optgroup key={g.key} label={g.label}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {swatches && (
        <div style={{ display: "flex", gap: 4 }}>
          {swatches.map((s) => (
            <span
              key={s.key}
              title={LAYER_LABEL[s.key]}
              style={{
                display: "inline-block",
                width: 18, height: 18,
                background: s.color,
                border: "1px solid #555",
                borderRadius: 3,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers shared by both views ─────────────────────────────────────

function fontOptions(layer: LayerKey, fonts: FontList): string[] {
  return layer === "annotation" ? fonts.cjk : fonts.all;
}

function patchLayer(
  setStyles: Props["setStyles"],
  layer: LayerKey,
  patch: Partial<LayerStyle>,
) {
  setStyles((s) => ({ ...s, [layer]: { ...s[layer], ...patch } }));
}

// ── LayerView (Pattern A — stacked cards) ─────────────────────────────

function LayerView({
  styles, setStyles, fonts, targetLang,
}: {
  styles: StyleConfig;
  setStyles: Props["setStyles"];
  fonts: FontList;
  targetLang: string;
}) {
  const phonOpts = phoneticOptions(targetLang);
  const jp = isJapanese(targetLang);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {LAYER_KEYS.map((k) => (
        <LayerCard
          key={k}
          layerKey={k}
          layer={styles[k]}
          styles={styles}
          fonts={fonts}
          setStyles={setStyles}
          phoneticOpts={phonOpts}
          japanese={jp}
        />
      ))}
    </div>
  );
}

function LayerCard({
  layerKey, layer, styles, fonts, setStyles, phoneticOpts, japanese,
}: {
  layerKey: LayerKey;
  layer: LayerStyle;
  styles: StyleConfig;
  fonts: FontList;
  setStyles: Props["setStyles"];
  phoneticOpts: PhoneticOption[];
  japanese: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opts = fontOptions(layerKey, fonts);
  const hasLangExtras =
    (layerKey === "romanized" && japanese) ||
    (layerKey === "annotation" && phoneticOpts.length > 0);

  return (
    <div style={{ border: "1px solid #2c2c2c", borderRadius: 6, background: "#1a1a1a" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "8px 12px",
          cursor: "pointer",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <input
          type="checkbox"
          checked={layer.enabled}
          onChange={(e) => patchLayer(setStyles, layerKey, { enabled: e.target.checked })}
          onClick={(e) => e.stopPropagation()}
          style={{ margin: 0 }}
        />
        <strong style={{ minWidth: 90, opacity: layer.enabled ? 1 : 0.4 }}>
          {LAYER_LABEL[layerKey]}
        </strong>
        <span
          style={{
            display: "inline-block",
            width: 16, height: 16,
            background: layer.primarycolor,
            border: "1px solid #555",
            borderRadius: 3,
            opacity: layer.enabled ? 1 : 0.4,
          }}
        />
        <span style={{ fontSize: "0.85em", opacity: 0.7, fontFamily: "monospace" }}>
          {layer.fontname} · {layer.fontsize}
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.8em" }}>
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 16,
            padding: "10px 14px 14px",
            borderTop: "1px solid #2c2c2c",
          }}
        >
          <div>
            <FieldLabel>Color</FieldLabel>
            <ColorRow
              color={layer.primarycolor}
              opacity={layer.primary_opacity}
              onColor={(c) => patchLayer(setStyles, layerKey, { primarycolor: c })}
              onOpacity={(o) => patchLayer(setStyles, layerKey, { primary_opacity: o })}
            />
          </div>
          <div>
            <FieldLabel>Typography</FieldLabel>
            <select
              value={layer.fontname}
              onChange={(e) => patchLayer(setStyles, layerKey, { fontname: e.target.value })}
              style={{ width: "100%", marginBottom: 6, padding: "3px 6px", fontSize: "0.85em" }}
            >
              {opts.includes(layer.fontname) ? null : (
                <option value={layer.fontname}>{layer.fontname} (?)</option>
              )}
              {opts.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <SizeRow
              size={layer.fontsize}
              onChange={(n) => patchLayer(setStyles, layerKey, { fontsize: n })}
            />
            <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
              <CheckboxLabel
                checked={layer.bold}
                onChange={(b) => patchLayer(setStyles, layerKey, { bold: b })}
                label="Bold"
              />
              <CheckboxLabel
                checked={layer.italic}
                onChange={(b) => patchLayer(setStyles, layerKey, { italic: b })}
                label="Italic"
              />
            </div>
          </div>
          <div>
            <FieldLabel>Effects</FieldLabel>
            <EffectsStack
              layer={layer}
              onPatch={(p) => patchLayer(setStyles, layerKey, p)}
            />
          </div>
          {hasLangExtras && (
            <div style={{ gridColumn: "1 / -1", borderTop: "1px dashed #2c2c2c", paddingTop: 10 }}>
              <FieldLabel>Language</FieldLabel>
              {layerKey === "romanized" && japanese && (
                <LongVowelControl
                  mode={styles.romanized.long_vowel_mode}
                  onChange={(m) =>
                    setStyles((s) => ({
                      ...s,
                      romanized: { ...s.romanized, long_vowel_mode: m },
                    }))
                  }
                />
              )}
              {layerKey === "annotation" && phoneticOpts.length > 0 && (
                <PhoneticControl
                  value={styles.annotation.phonetic_system ?? null}
                  options={phoneticOpts}
                  onChange={(v) =>
                    setStyles((s) => ({
                      ...s,
                      annotation: { ...s.annotation, phonetic_system: v },
                    }))
                  }
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EffectsStack({
  layer, onPatch,
}: { layer: LayerStyle; onPatch: (p: Partial<LayerStyle>) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <OutlineControl layer={layer} onPatch={onPatch} />
      <ShadowControl layer={layer} onPatch={onPatch} />
      <GlowControl layer={layer} onPatch={onPatch} />
    </div>
  );
}

// ── PropertyView (column-per-layer) ─────────────────────────────────
// Each layer is its own column with all its controls stacked + left-
// justified. Column heights vary freely — Romanized gets long-vowel in
// JP, Annotation gets phonetic in zh/yue/th, others skip that section.

function PropertyView({
  styles, setStyles, fonts, targetLang,
}: {
  styles: StyleConfig;
  setStyles: Props["setStyles"];
  fonts: FontList;
  targetLang: string;
}) {
  const phonOpts = phoneticOptions(targetLang);
  const jp = isJapanese(targetLang);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${LAYER_KEYS.length}, minmax(0, 1fr))`,
        gap: 10,
        alignItems: "start",
      }}
    >
      {LAYER_KEYS.map((k) => (
        <LayerColumn
          key={k}
          layerKey={k}
          styles={styles}
          setStyles={setStyles}
          fonts={fonts}
          phoneticOpts={phonOpts}
          japanese={jp}
        />
      ))}
    </div>
  );
}

function LayerColumn({
  layerKey, styles, setStyles, fonts, phoneticOpts, japanese,
}: {
  layerKey: LayerKey;
  styles: StyleConfig;
  setStyles: Props["setStyles"];
  fonts: FontList;
  phoneticOpts: PhoneticOption[];
  japanese: boolean;
}) {
  const layer = styles[layerKey];
  const opts = fontOptions(layerKey, fonts);
  const showLang =
    (layerKey === "romanized" && japanese) ||
    (layerKey === "annotation" && phoneticOpts.length > 0);
  const dim = !layer.enabled;

  return (
    <div
      style={{
        border: "1px solid #2c2c2c",
        borderRadius: 6,
        background: "#1a1a1a",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minWidth: 0,
      }}
    >
      <label
        style={{
          display: "flex", alignItems: "center", gap: 8,
          borderBottom: "1px solid #2c2c2c",
          paddingBottom: 8, cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={layer.enabled}
          onChange={(e) => patchLayer(setStyles, layerKey, { enabled: e.target.checked })}
          style={{ margin: 0 }}
        />
        <strong style={{ fontSize: "0.95em", opacity: dim ? 0.4 : 1 }}>
          {LAYER_LABEL[layerKey]}
        </strong>
      </label>

      <ColumnSection label="Color">
        <ColorRow
          color={layer.primarycolor}
          opacity={layer.primary_opacity}
          onColor={(c) => patchLayer(setStyles, layerKey, { primarycolor: c })}
          onOpacity={(o) => patchLayer(setStyles, layerKey, { primary_opacity: o })}
        />
      </ColumnSection>

      <ColumnSection label="Typography">
        <select
          value={layer.fontname}
          onChange={(e) => patchLayer(setStyles, layerKey, { fontname: e.target.value })}
          style={{ padding: "3px 6px", fontSize: "0.85em", width: "100%" }}
        >
          {opts.includes(layer.fontname) ? null : (
            <option value={layer.fontname}>{layer.fontname} (?)</option>
          )}
          {opts.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <SizeRow
          size={layer.fontsize}
          onChange={(n) => patchLayer(setStyles, layerKey, { fontsize: n })}
        />
        <div style={{ display: "flex", gap: 12 }}>
          <CheckboxLabel
            checked={layer.bold}
            onChange={(b) => patchLayer(setStyles, layerKey, { bold: b })}
            label="Bold"
          />
          <CheckboxLabel
            checked={layer.italic}
            onChange={(b) => patchLayer(setStyles, layerKey, { italic: b })}
            label="Italic"
          />
        </div>
      </ColumnSection>

      <ColumnSection label="Effects">
        <EffectsStack
          layer={layer}
          onPatch={(p) => patchLayer(setStyles, layerKey, p)}
        />
      </ColumnSection>

      {showLang && (
        <ColumnSection label="Language">
          {layerKey === "romanized" && japanese && (
            <LongVowelControl
              mode={styles.romanized.long_vowel_mode}
              onChange={(m) =>
                setStyles((s) => ({
                  ...s,
                  romanized: { ...s.romanized, long_vowel_mode: m },
                }))
              }
            />
          )}
          {layerKey === "annotation" && phoneticOpts.length > 0 && (
            <PhoneticControl
              value={styles.annotation.phonetic_system ?? null}
              options={phoneticOpts}
              onChange={(v) =>
                setStyles((s) => ({
                  ...s,
                  annotation: { ...s.annotation, phonetic_system: v },
                }))
              }
            />
          )}
        </ColumnSection>
      )}
    </div>
  );
}

function ColumnSection({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

// ── Small reusable controls ──────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.75em", opacity: 0.55, marginBottom: 6,
        textTransform: "uppercase", letterSpacing: "0.08em",
      }}
    >
      {children}
    </div>
  );
}

function ColorRow({
  color, opacity, onColor, onOpacity, disabled = false,
}: {
  color: string;
  opacity: number;
  onColor: (c: string) => void;
  onOpacity: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="color"
        value={color}
        disabled={disabled}
        onChange={(e) => onColor(e.target.value.toUpperCase())}
        style={{ width: 32, height: 24, padding: 0, border: "1px solid #444", background: "transparent" }}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={opacity}
        disabled={disabled}
        onChange={(e) => onOpacity(Number(e.target.value))}
        style={{ flex: 1, minWidth: 60 }}
        title={`${opacity}%`}
      />
      <span style={{ fontSize: "0.75em", opacity: 0.6, fontFamily: "monospace", width: 32, textAlign: "right" }}>
        {opacity}%
      </span>
    </div>
  );
}

function SizeRow({
  size, onChange,
}: { size: number; onChange: (n: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="range"
        min={8}
        max={150}
        value={size}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 60 }}
      />
      <input
        type="number"
        min={8}
        max={150}
        value={size}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        style={{ width: 52, padding: "2px 4px", fontSize: "0.85em" }}
      />
    </div>
  );
}

function OutlineControl({
  layer, onPatch,
}: { layer: LayerStyle; onPatch: (p: Partial<LayerStyle>) => void }) {
  const dim = !layer.outline_enabled;
  return (
    <div>
      <EffectHeader
        label="Outline"
        checked={layer.outline_enabled}
        onChange={(b) => onPatch({ outline_enabled: b })}
      />
      <div style={{ opacity: dim ? 0.4 : 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <FloatRow
          label="width"
          value={layer.outline}
          min={0}
          max={10}
          step={0.5}
          disabled={dim}
          onChange={(n) => onPatch({ outline: n })}
        />
        <ColorRow
          color={layer.outlinecolor}
          opacity={layer.outline_opacity}
          disabled={dim}
          onColor={(c) => onPatch({ outlinecolor: c })}
          onOpacity={(o) => onPatch({ outline_opacity: o })}
        />
      </div>
    </div>
  );
}

function ShadowControl({
  layer, onPatch,
}: { layer: LayerStyle; onPatch: (p: Partial<LayerStyle>) => void }) {
  const dim = !layer.shadow_enabled;
  return (
    <div>
      <EffectHeader
        label="Shadow"
        checked={layer.shadow_enabled}
        onChange={(b) => onPatch({ shadow_enabled: b })}
      />
      <div style={{ opacity: dim ? 0.4 : 1 }}>
        <FloatRow
          label="distance"
          value={layer.shadow}
          min={0}
          max={10}
          step={0.5}
          disabled={dim}
          onChange={(n) => onPatch({ shadow: n })}
        />
      </div>
    </div>
  );
}

function GlowControl({
  layer, onPatch,
}: { layer: LayerStyle; onPatch: (p: Partial<LayerStyle>) => void }) {
  const dim = !layer.glow_enabled;
  return (
    <div>
      <EffectHeader
        label="Glow"
        checked={layer.glow_enabled}
        onChange={(b) => onPatch({ glow_enabled: b })}
      />
      <div style={{ opacity: dim ? 0.4 : 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <IntRow
          label="radius"
          value={layer.glow_radius}
          min={0}
          max={20}
          disabled={dim}
          onChange={(n) => onPatch({ glow_radius: n })}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "0.75em", opacity: 0.55, width: 56 }}>color</span>
          <input
            type="color"
            value={layer.glow_color_hex}
            disabled={dim}
            onChange={(e) => onPatch({ glow_color_hex: e.target.value.toUpperCase() })}
            style={{ width: 32, height: 24, padding: 0, border: "1px solid #444", background: "transparent" }}
          />
        </div>
      </div>
    </div>
  );
}

function EffectHeader({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <label
      style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: "0.82em", marginBottom: 4, cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0 }}
      />
      <strong style={{ opacity: checked ? 1 : 0.5 }}>{label}</strong>
    </label>
  );
}

function FloatRow({
  label, value, min, max, step, disabled, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  disabled: boolean; onChange: (n: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: "0.75em", opacity: 0.55, width: 56 }}>{label}</span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 40 }}
      />
      <input
        type="number"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        style={{ width: 48, padding: "2px 4px", fontSize: "0.8em" }}
      />
    </div>
  );
}

function IntRow({
  label, value, min, max, disabled, onChange,
}: {
  label: string; value: number; min: number; max: number;
  disabled: boolean; onChange: (n: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: "0.75em", opacity: 0.55, width: 56 }}>{label}</span>
      <input
        type="range"
        min={min} max={max} step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 40 }}
      />
      <span style={{ fontSize: "0.75em", opacity: 0.6, fontFamily: "monospace", width: 24, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

function LongVowelControl({
  mode, onChange,
}: { mode: LongVowelMode; onChange: (m: LongVowelMode) => void }) {
  return (
    <select
      value={mode}
      onChange={(e) => onChange(e.target.value as LongVowelMode)}
      style={{ padding: "3px 6px", fontSize: "0.85em", width: "100%" }}
    >
      {LONG_VOWEL_MODES.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function PhoneticControl({
  value, options, onChange,
}: {
  value: PhoneticSystem | null;
  options: PhoneticOption[];
  onChange: (v: PhoneticSystem | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : (v as PhoneticSystem));
      }}
      style={{ padding: "3px 6px", fontSize: "0.85em", width: "100%" }}
    >
      <option value="">— Default —</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function StackPositionBlock({
  styles, setStyles,
}: { styles: StyleConfig; setStyles: Props["setStyles"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 14, border: "1px solid #2c2c2c", borderRadius: 6, background: "#1a1a1a" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "8px 12px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 8,
        }}
      >
        <strong style={{ fontSize: "0.9em" }}>Top Stack Position</strong>
        <span style={{ opacity: 0.5, fontSize: "0.8em", fontFamily: "monospace" }}>
          offset {styles.vertical_offset}px · ann {styles.annotation_gap}px · rom {styles.romanized_gap}px
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.8em" }}>
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div style={{ padding: "10px 14px 14px", borderTop: "1px solid #2c2c2c", display: "flex", flexDirection: "column", gap: 8 }}>
          <StackSlider
            label="Vertical offset"
            value={styles.vertical_offset}
            min={-100} max={100}
            help="Shifts the entire top stack up (positive) or down."
            onChange={(n) => setStyles((s) => ({ ...s, vertical_offset: n }))}
          />
          <StackSlider
            label="Annotation gap"
            value={styles.annotation_gap}
            min={-20} max={40}
            help="Space between the annotation layer and the target line."
            onChange={(n) => setStyles((s) => ({ ...s, annotation_gap: n }))}
          />
          <StackSlider
            label="Romanized gap"
            value={styles.romanized_gap}
            min={-20} max={40}
            help="Space between the romanized line and the target line."
            onChange={(n) => setStyles((s) => ({ ...s, romanized_gap: n }))}
          />
        </div>
      )}
    </div>
  );
}

function StackSlider({
  label, value, min, max, help, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  help?: string;
  onChange: (n: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 130, fontSize: "0.85em" }} title={help}>{label}</span>
      <input
        type="range"
        min={min} max={max} step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <input
        type="number"
        min={min} max={max} step={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        style={{ width: 60, padding: "2px 4px", fontSize: "0.85em" }}
      />
    </div>
  );
}

function CheckboxLabel({
  checked, onChange, label,
}: { checked: boolean; onChange: (b: boolean) => void; label: string }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.85em", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0 }}
      />
      {label}
    </label>
  );
}
