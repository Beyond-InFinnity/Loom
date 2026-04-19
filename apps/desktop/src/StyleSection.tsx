import { useEffect, useMemo, useState } from "react";
import {
  applyPreset,
  fetchFonts,
  fetchPresets,
  FontList,
  LAYER_KEYS,
  LAYER_LABEL,
  LAYER_WIRE,
  LayerKey,
  LayerStyle,
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
        view === "layer" ? (
          <LayerView styles={styles} setStyles={setStyles} fonts={fonts} />
        ) : (
          <PropertyView styles={styles} setStyles={setStyles} fonts={fonts} />
        )
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
  styles, setStyles, fonts,
}: { styles: StyleConfig; setStyles: Props["setStyles"]; fonts: FontList }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {LAYER_KEYS.map((k) => (
        <LayerCard
          key={k}
          layerKey={k}
          layer={styles[k]}
          fonts={fonts}
          setStyles={setStyles}
        />
      ))}
    </div>
  );
}

function LayerCard({
  layerKey, layer, fonts, setStyles,
}: {
  layerKey: LayerKey;
  layer: LayerStyle;
  fonts: FontList;
  setStyles: Props["setStyles"];
}) {
  const [open, setOpen] = useState(false);
  const opts = fontOptions(layerKey, fonts);

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
            <span style={{ fontSize: "0.8em", opacity: 0.4 }}>(coming in 3-2)</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── PropertyView (Pattern B — grouped grid) ──────────────────────────

function PropertyView({
  styles, setStyles, fonts,
}: { styles: StyleConfig; setStyles: Props["setStyles"]; fonts: FontList }) {
  const cols = `120px repeat(${LAYER_KEYS.length}, 1fr)`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center" }}>
        <span />
        {LAYER_KEYS.map((k) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={styles[k].enabled}
              onChange={(e) => patchLayer(setStyles, k, { enabled: e.target.checked })}
              style={{ margin: 0 }}
            />
            <strong style={{ fontSize: "0.9em", opacity: styles[k].enabled ? 1 : 0.4 }}>
              {LAYER_LABEL[k]}
            </strong>
          </div>
        ))}
      </div>

      <PropertyGroup label="Colors" cols={cols}>
        <PropertyRow label="text" cols={cols}>
          {LAYER_KEYS.map((k) => (
            <ColorRow
              key={k}
              color={styles[k].primarycolor}
              opacity={styles[k].primary_opacity}
              onColor={(c) => patchLayer(setStyles, k, { primarycolor: c })}
              onOpacity={(o) => patchLayer(setStyles, k, { primary_opacity: o })}
            />
          ))}
        </PropertyRow>
      </PropertyGroup>

      <PropertyGroup label="Typography" cols={cols}>
        <PropertyRow label="font" cols={cols}>
          {LAYER_KEYS.map((k) => {
            const opts = fontOptions(k, fonts);
            const layer = styles[k];
            return (
              <select
                key={k}
                value={layer.fontname}
                onChange={(e) => patchLayer(setStyles, k, { fontname: e.target.value })}
                style={{ padding: "3px 6px", fontSize: "0.85em" }}
              >
                {opts.includes(layer.fontname) ? null : (
                  <option value={layer.fontname}>{layer.fontname} (?)</option>
                )}
                {opts.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            );
          })}
        </PropertyRow>
        <PropertyRow label="size" cols={cols}>
          {LAYER_KEYS.map((k) => (
            <SizeRow
              key={k}
              size={styles[k].fontsize}
              onChange={(n) => patchLayer(setStyles, k, { fontsize: n })}
            />
          ))}
        </PropertyRow>
        <PropertyRow label="bold / italic" cols={cols}>
          {LAYER_KEYS.map((k) => (
            <div key={k} style={{ display: "flex", gap: 10 }}>
              <CheckboxLabel
                checked={styles[k].bold}
                onChange={(b) => patchLayer(setStyles, k, { bold: b })}
                label="B"
              />
              <CheckboxLabel
                checked={styles[k].italic}
                onChange={(b) => patchLayer(setStyles, k, { italic: b })}
                label="I"
              />
            </div>
          ))}
        </PropertyRow>
      </PropertyGroup>
    </div>
  );
}

function PropertyGroup({
  label, cols, children,
}: { label: string; cols: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: cols,
          padding: "4px 0 6px",
          borderBottom: "1px solid #2c2c2c",
          marginBottom: 6,
        }}
      >
        <strong style={{ fontSize: "0.78em", letterSpacing: "0.08em", opacity: 0.6, textTransform: "uppercase" }}>
          {label}
        </strong>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

function PropertyRow({
  label, cols, children,
}: { label: string; cols: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center" }}>
      <span style={{ fontSize: "0.8em", opacity: 0.55 }}>{label}</span>
      {children}
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
  color, opacity, onColor, onOpacity,
}: {
  color: string;
  opacity: number;
  onColor: (c: string) => void;
  onOpacity: (n: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="color"
        value={color}
        onChange={(e) => onColor(e.target.value.toUpperCase())}
        style={{ width: 32, height: 24, padding: 0, border: "1px solid #444", background: "transparent" }}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={opacity}
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
