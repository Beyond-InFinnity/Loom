// SSAFile — minimal port of pysubs2.SSAFile.  Hand-written rather than
// pulling a JS lib because (a) the formats are well-defined, (b) we
// control the round-trip exactly, (c) pysubs2's surface area we use
// is small enough that vendoring is overkill.
//
// Supports parsing .srt and .ass (auto-detected from header), and
// serializing to .ass.  Other pysubs2 features (SubStation Alpha v3
// quirks, MicroDVD, MPL2, .vtt) are intentionally NOT implemented —
// the only inputs we get are subrip/ass tracks extracted via 4c
// (FFmpegClient.extractTrack).

import { parseAssColor, formatAssColor } from "./color";
import { formatAssTimestamp, parseAssTimestamp, parseSrtTimestamp } from "./timestamp";
import type { SSAEvent, SSAFileShape, SSAStyle } from "./types";
import { defaultStyle } from "./types";

const ASS_STYLE_FIELDS = [
  "Name", "Fontname", "Fontsize",
  "PrimaryColour", "SecondaryColour", "OutlineColour", "BackColour",
  "Bold", "Italic", "Underline", "StrikeOut",
  "ScaleX", "ScaleY", "Spacing", "Angle",
  "BorderStyle", "Outline", "Shadow",
  "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
] as const;

const ASS_EVENT_FIELDS = [
  "Layer", "Start", "End", "Style", "Name",
  "MarginL", "MarginR", "MarginV", "Effect", "Text",
] as const;

export class SSAFile implements SSAFileShape {
  info: Record<string, string>;
  styles: Map<string, SSAStyle>;
  events: SSAEvent[];

  constructor(init?: Partial<SSAFileShape>) {
    this.info = init?.info ?? {};
    this.styles = init?.styles ?? new Map();
    this.events = init?.events ?? [];
  }

  // ── Parse ────────────────────────────────────────────────────

  /** Auto-detect format and parse.  Detection: presence of `[Script Info]`
      → ASS; otherwise treat as SRT.  The `format` arg overrides. */
  static fromString(text: string, format?: "srt" | "ass"): SSAFile {
    if (!format) {
      format = /\[Script Info\]/i.test(text) ? "ass" : "srt";
    }
    return format === "ass" ? this.fromAss(text) : this.fromSrt(text);
  }

  /** Parse SRT (SubRip) — blocks separated by blank line, each block:
      `<index>\n<HH:MM:SS,mmm --> HH:MM:SS,mmm>\n<text...>`. */
  static fromSrt(text: string): SSAFile {
    const subs = new SSAFile({
      info: {
        Title: "Loom imported (from SRT)",
        ScriptType: "v4.00+",
        WrapStyle: "0",
        ScaledBorderAndShadow: "yes",
      },
      styles: new Map([["Default", defaultStyle("Default")]]),
      events: [],
    });

    // Strip BOM, normalize newlines.  SRT in the wild often has CRLF;
    // also tolerate trailing whitespace lines that break naive splits.
    const norm = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = norm.split(/\n\n+/);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const lines = trimmed.split("\n");
      // First line MAY be a numeric index (most files have it; some don't).
      let i = 0;
      if (/^\d+$/.test(lines[0])) i = 1;
      const timingLine = lines[i];
      if (!timingLine) continue;
      const m = timingLine.match(/^([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (!m) continue;
      const start = parseSrtTimestamp(m[1]);
      const end = parseSrtTimestamp(m[2]);
      const textLines = lines.slice(i + 1).join("\\N"); // SRT line breaks → ASS \N
      // Strip basic SRT formatting tags <b>/<i>/<u>/<font color="...">
      // — pysubs2 also drops these.  Keep the raw text in event.text;
      // production processing handles ASS override tags only.
      const cleaned = textLines
        .replace(/<\/?[bi]>/g, "")
        .replace(/<\/?u>/g, "")
        .replace(/<font[^>]*>|<\/font>/g, "");
      subs.events.push({
        type: "Dialogue",
        layer: 0,
        start, end,
        style: "Default",
        name: "",
        margin_l: 0, margin_r: 0, margin_v: 0,
        effect: "",
        text: cleaned,
      });
    }

    return subs;
  }

  /** Parse ASS / SSA — section-based INI-ish format. */
  static fromAss(text: string): SSAFile {
    const subs = new SSAFile();
    const norm = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = norm.split("\n");

    let section: string | null = null;
    let stylesFormat: string[] | null = null;
    let eventsFormat: string[] | null = null;

    for (let raw of lines) {
      // ASS lines that start with `;` are comments outside [Events].
      const line = raw.replace(/\s+$/, "");
      if (!line) continue;
      const sect = line.match(/^\[(.+)\]\s*$/);
      if (sect) {
        section = sect[1].trim();
        stylesFormat = null;
        eventsFormat = null;
        continue;
      }
      if (line.startsWith(";")) continue;

      if (section === "Script Info") {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key) subs.info[key] = value;
        continue;
      }

      if (section === "V4+ Styles" || section === "V4 Styles") {
        if (line.toLowerCase().startsWith("format:")) {
          stylesFormat = line.slice("format:".length).split(",").map((s) => s.trim());
          continue;
        }
        if (line.toLowerCase().startsWith("style:")) {
          if (!stylesFormat) {
            // Some ASS files omit the Format line; assume canonical order.
            stylesFormat = [...ASS_STYLE_FIELDS];
          }
          const values = splitAssRow(line.slice("style:".length), stylesFormat.length);
          const style = parseAssStyle(stylesFormat, values);
          subs.styles.set(style.name, style);
        }
        continue;
      }

      if (section === "Events") {
        if (line.toLowerCase().startsWith("format:")) {
          eventsFormat = line.slice("format:".length).split(",").map((s) => s.trim());
          continue;
        }
        const dialogueMatch = line.match(/^(Dialogue|Comment):\s*(.*)$/i);
        if (dialogueMatch) {
          if (!eventsFormat) eventsFormat = [...ASS_EVENT_FIELDS];
          const type = dialogueMatch[1].toLowerCase() === "comment" ? "Comment" : "Dialogue";
          const values = splitAssRow(dialogueMatch[2], eventsFormat.length);
          subs.events.push(parseAssEvent(eventsFormat, values, type));
        }
        continue;
      }

      // Unknown section — ignore (Fonts, Graphics, etc.).
    }

    // Default style fallback if the file declared none.
    if (subs.styles.size === 0) {
      subs.styles.set("Default", defaultStyle("Default"));
    }

    return subs;
  }

  // ── Serialize ────────────────────────────────────────────────

  /** Serialize to an ASS file string.  Uses canonical ASS v4+ field
      order — round-tripping a file written by Aegisub or pysubs2 will
      produce a structurally identical (though not byte-identical) result. */
  toAss(): string {
    const out: string[] = [];
    out.push("[Script Info]");
    if (!this.info["ScriptType"]) this.info["ScriptType"] = "v4.00+";
    for (const [k, v] of Object.entries(this.info)) {
      out.push(`${k}: ${v}`);
    }
    out.push("");

    out.push("[V4+ Styles]");
    out.push(`Format: ${ASS_STYLE_FIELDS.join(", ")}`);
    for (const style of this.styles.values()) {
      out.push(`Style: ${formatAssStyleRow(style)}`);
    }
    out.push("");

    out.push("[Events]");
    out.push(`Format: ${ASS_EVENT_FIELDS.join(", ")}`);
    for (const ev of this.events) {
      out.push(`${ev.type}: ${formatAssEventRow(ev)}`);
    }
    out.push(""); // trailing newline keeps players happy

    return out.join("\n");
  }

  // ── Mutation helpers (mirror pysubs2.SSAFile.shift) ───────────

  /** Return a new SSAFile with all event timings shifted by `offsetMs`.
      Clamps to >= 0 (matches loom_core/subs/utils.py::shift_events). */
  shifted(offsetMs: number): SSAFile {
    const next = new SSAFile({
      info: { ...this.info },
      styles: new Map(this.styles),
      events: this.events.map((e) => ({
        ...e,
        start: Math.max(0, e.start + offsetMs),
        end: Math.max(0, e.end + offsetMs),
      })),
    });
    return next;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Split an ASS Style/Event row into `expectedFields` columns.  ASS uses
    comma separators except inside the Text field which can contain
    commas — the Text field is always last and gets the rest verbatim. */
function splitAssRow(rest: string, expectedFields: number): string[] {
  // Trim leading whitespace only (Text might want trailing whitespace).
  const s = rest.replace(/^\s+/, "");
  const parts: string[] = [];
  let i = 0;
  // First (expectedFields - 1) columns are comma-delimited; the last
  // column gets the entire remainder so embedded commas survive.
  for (let f = 0; f < expectedFields - 1; f++) {
    const c = s.indexOf(",", i);
    if (c < 0) { parts.push(s.slice(i)); i = s.length; break; }
    parts.push(s.slice(i, c));
    i = c + 1;
  }
  parts.push(s.slice(i));
  // Trim only the leading delimiter whitespace for non-last fields.
  return parts.map((p, idx) => idx === parts.length - 1 ? p : p.trim());
}

function parseAssStyle(format: string[], values: string[]): SSAStyle {
  const get = (name: string): string => {
    const idx = format.indexOf(name);
    return idx >= 0 ? values[idx] ?? "" : "";
  };
  const num = (name: string, dflt: number): number => {
    const v = get(name);
    if (!v) return dflt;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const intNum = (name: string, dflt: number): number => Math.round(num(name, dflt));
  const bool = (name: string): boolean => {
    const v = get(name).trim();
    // ASS: -1 = true, 0 = false.  Some files use 1.
    return v === "-1" || v === "1";
  };
  const color = (name: string, dflt: string): { r: number; g: number; b: number; a: number } => {
    const v = get(name);
    try { return parseAssColor(v || dflt); } catch { return parseAssColor(dflt); }
  };
  return {
    name: get("Name") || "Default",
    fontname: get("Fontname") || "Arial",
    fontsize: num("Fontsize", 20),
    primarycolor: color("PrimaryColour", "&H00FFFFFF"),
    secondarycolor: color("SecondaryColour", "&H000000FF"),
    outlinecolor: color("OutlineColour", "&H00000000"),
    backcolor: color("BackColour", "&H00000000"),
    bold: bool("Bold"),
    italic: bool("Italic"),
    underline: bool("Underline"),
    strikeout: bool("StrikeOut"),
    scale_x: num("ScaleX", 100),
    scale_y: num("ScaleY", 100),
    spacing: num("Spacing", 0),
    angle: num("Angle", 0),
    border_style: intNum("BorderStyle", 1),
    outline: num("Outline", 2),
    shadow: num("Shadow", 2),
    alignment: intNum("Alignment", 2),
    margin_l: intNum("MarginL", 10),
    margin_r: intNum("MarginR", 10),
    margin_v: intNum("MarginV", 10),
    encoding: intNum("Encoding", 1),
  };
}

function formatAssStyleRow(s: SSAStyle): string {
  const cells: Record<typeof ASS_STYLE_FIELDS[number], string> = {
    Name: s.name,
    Fontname: s.fontname,
    Fontsize: numStr(s.fontsize),
    PrimaryColour: formatAssColor(s.primarycolor),
    SecondaryColour: formatAssColor(s.secondarycolor),
    OutlineColour: formatAssColor(s.outlinecolor),
    BackColour: formatAssColor(s.backcolor),
    Bold: s.bold ? "-1" : "0",
    Italic: s.italic ? "-1" : "0",
    Underline: s.underline ? "-1" : "0",
    StrikeOut: s.strikeout ? "-1" : "0",
    ScaleX: numStr(s.scale_x),
    ScaleY: numStr(s.scale_y),
    Spacing: numStr(s.spacing),
    Angle: numStr(s.angle),
    BorderStyle: String(s.border_style),
    Outline: numStr(s.outline),
    Shadow: numStr(s.shadow),
    Alignment: String(s.alignment),
    MarginL: String(s.margin_l),
    MarginR: String(s.margin_r),
    MarginV: String(s.margin_v),
    Encoding: String(s.encoding),
  };
  return ASS_STYLE_FIELDS.map((f) => cells[f]).join(",");
}

function parseAssEvent(format: string[], values: string[], type: "Dialogue" | "Comment"): SSAEvent {
  const get = (name: string): string => {
    const idx = format.indexOf(name);
    return idx >= 0 ? values[idx] ?? "" : "";
  };
  return {
    type,
    layer: parseInt(get("Layer") || "0", 10),
    start: parseAssTimestamp(get("Start")),
    end: parseAssTimestamp(get("End")),
    style: get("Style") || "Default",
    name: get("Name"),
    margin_l: parseInt(get("MarginL") || "0", 10),
    margin_r: parseInt(get("MarginR") || "0", 10),
    margin_v: parseInt(get("MarginV") || "0", 10),
    effect: get("Effect"),
    text: get("Text"),
  };
}

function formatAssEventRow(e: SSAEvent): string {
  const cells: Record<typeof ASS_EVENT_FIELDS[number], string> = {
    Layer: String(e.layer),
    Start: formatAssTimestamp(e.start),
    End: formatAssTimestamp(e.end),
    Style: e.style,
    Name: e.name,
    MarginL: String(e.margin_l),
    MarginR: String(e.margin_r),
    MarginV: String(e.margin_v),
    Effect: e.effect,
    Text: e.text,
  };
  return ASS_EVENT_FIELDS.map((f) => cells[f]).join(",");
}

/** Format a number for ASS — drop trailing zeros so "20" not "20.0". */
function numStr(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}
