// Color preset wire types — vendored from @loom/api-client schemas to
// avoid leaking the deep openapi-typescript shape into every consumer.
// Field shape mirrors PresetCatalog / Preset / LayerColors in
// loom_core/color_presets.py and packages/api-client/src/types.ts.
//
// Layer keys: "Bottom" / "Top" / "Romanized" / "Annotation".  The
// extension exposes Bottom + Top + Annotation as user-controllable
// colors today; "Romanized" lands with 5e.  Opacity / outline /
// glow fields are part of the wire shape but the extension hasn't
// surfaced UI controls for them yet — preset application ignores
// them silently and applies only the .color field.

export interface PresetLayerColors {
  color: string;
  opacity: number;
  outline_color: string;
  outline_opacity: number;
  glow_color: string | null;
  glow_opacity: number | null;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  /** "classic" | "cultural" | "dark" | "adaptive" */
  group: string;
  layers: Record<string, PresetLayerColors>;
  /** null = universal; otherwise BCP-47 codes the preset is scoped to */
  languages: string[] | null;
}

export interface PresetGroup {
  key: string;
  label: string;
}

export interface PresetCatalog {
  groups: PresetGroup[];
  presets: Preset[];
}
