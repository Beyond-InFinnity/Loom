// TypeScript mirrors of pysubs2's SSAFile / SSAEvent / SSAStyle / Color
// — minimal surface that loom_core/subs/processing.py actually uses.
// Field names match Python's snake_case to keep porting mechanical.

/** ASS color in standard form.  pysubs2 stores as `Color(r, g, b, a)`
    where `a` is INVERTED alpha (0=opaque, 255=transparent — matches
    the ASS file format).  Hex round-trip helpers in lib/subs/color.ts. */
export interface Color {
  r: number; // 0–255
  g: number; // 0–255
  b: number; // 0–255
  a: number; // 0–255, inverted (0=opaque)
}

/** One subtitle event (Dialogue or Comment line in [Events]). */
export interface SSAEvent {
  type: "Dialogue" | "Comment";
  layer: number;
  /** Start time in MILLISECONDS since file start (NOT seconds). */
  start: number;
  /** End time in MILLISECONDS. */
  end: number;
  style: string;
  name: string;
  margin_l: number;
  margin_r: number;
  margin_v: number;
  effect: string;
  /** Raw event text including ASS override tags like `{\\pos(100,200)}`. */
  text: string;
}

/** Convenience derived view that mirrors pysubs2's `event.is_comment` boolean. */
export function isComment(e: SSAEvent): boolean {
  return e.type === "Comment";
}

/** One named style in [V4+ Styles].  Field names match the ASS spec. */
export interface SSAStyle {
  name: string;
  fontname: string;
  fontsize: number;
  primarycolor: Color;
  secondarycolor: Color;
  outlinecolor: Color;
  backcolor: Color;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  scale_x: number;     // percent (100 = no scale)
  scale_y: number;     // percent
  spacing: number;     // px between letters
  angle: number;       // degrees
  border_style: number; // 1 = outline+shadow, 3 = opaque box
  outline: number;     // outline width in px
  shadow: number;      // shadow distance in px
  alignment: number;   // numpad layout: 1=BL,2=BC,3=BR,4=ML,5=MC,6=MR,7=TL,8=TC,9=TR
  margin_l: number;
  margin_r: number;
  margin_v: number;
  encoding: number;    // 1 = default
}

/** A complete subtitle file: script info + named styles + events.
    Mirrors pysubs2.SSAFile's three top-level collections. */
export interface SSAFileShape {
  /** [Script Info] section as case-insensitive key→value dict.
      Common keys: Title, ScriptType, PlayResX, PlayResY, WrapStyle,
      ScaledBorderAndShadow, Collisions, YCbCr Matrix, Timer. */
  info: Record<string, string>;
  /** Styles indexed by name.  Iteration order = source file order. */
  styles: Map<string, SSAStyle>;
  /** Events in source-file order. */
  events: SSAEvent[];
}

/** ASS "default" style — used when serializing files that have no
    named styles (e.g. SRT input).  Mirrors pysubs2.SSAStyle defaults. */
export function defaultStyle(name = "Default"): SSAStyle {
  return {
    name,
    fontname: "Arial",
    fontsize: 20,
    primarycolor: { r: 255, g: 255, b: 255, a: 0 },
    secondarycolor: { r: 255, g: 0, b: 0, a: 0 },
    outlinecolor: { r: 0, g: 0, b: 0, a: 0 },
    backcolor: { r: 0, g: 0, b: 0, a: 0 },
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    scale_x: 100,
    scale_y: 100,
    spacing: 0,
    angle: 0,
    border_style: 1,
    outline: 2,
    shadow: 2,
    alignment: 2, // bottom-center
    margin_l: 10,
    margin_r: 10,
    margin_v: 10,
    encoding: 1,
  };
}
