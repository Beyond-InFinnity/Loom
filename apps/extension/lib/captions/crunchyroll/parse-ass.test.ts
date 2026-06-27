import { describe, expect, it } from "vitest";

import { assTimeToMs, cleanAssText, parseAss } from "./parse-ass";

describe("assTimeToMs", () => {
  it("parses H:MM:SS.cc (centiseconds)", () => {
    expect(assTimeToMs("0:00:01.50")).toBe(1500);
  });
  it("scales centiseconds, not milliseconds", () => {
    expect(assTimeToMs("0:00:00.05")).toBe(50); // 5cs = 50ms
  });
  it("parses multi-hour timestamps", () => {
    expect(assTimeToMs("1:02:03.04")).toBe(3723040);
  });
  it("returns null for garbage", () => {
    expect(assTimeToMs("not a time")).toBeNull();
  });
});

describe("cleanAssText", () => {
  it("strips override blocks", () => {
    expect(cleanAssText("{\\i1}Hello{\\i0} world")).toBe("Hello world");
  });
  it("strips positioning/style overrides", () => {
    expect(cleanAssText("{\\an8}{\\pos(960,100)}Top line")).toBe("Top line");
  });
  it("converts \\N and \\n to newlines", () => {
    expect(cleanAssText("line one\\Nline two")).toBe("line one\nline two");
    expect(cleanAssText("line one\\nline two")).toBe("line one\nline two");
  });
  it("converts \\h to a space", () => {
    expect(cleanAssText("a\\hb")).toBe("a b");
  });
  it("collapses internal whitespace runs per line", () => {
    expect(cleanAssText("foo    bar")).toBe("foo bar");
  });
  it("drops vector-drawing runs between {\\p1} and {\\p0}", () => {
    expect(cleanAssText("{\\p1}m 0 0 l 100 0 100 100{\\p0}real text")).toBe(
      "real text",
    );
  });
  it("survives an unterminated override block", () => {
    expect(cleanAssText("text {\\broken")).toBe("text");
  });
});

const SAMPLE = [
  "[Script Info]",
  "Title: Default file",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour",
  "Style: Default,Arial,20,&H00FFFFFF",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}First{\\i0} cue",
  "Comment: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,this is a comment, skip it",
  "Dialogue: 0,0:00:05.50,0:00:07.25,Default,,0,0,0,,Second, with a comma",
  "Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,",
].join("\n");

describe("parseAss", () => {
  it("parses Dialogue lines from the [Events] section only", () => {
    const cues = parseAss(SAMPLE);
    expect(cues).toHaveLength(2); // comment + empty-text cue dropped
  });

  it("resolves Start/End/Text by the Format header", () => {
    const [first] = parseAss(SAMPLE);
    expect(first).toEqual({ start: 1000, end: 3000, text: "First cue" });
  });

  it("preserves commas inside the Text column", () => {
    const second = parseAss(SAMPLE)[1];
    expect(second.text).toBe("Second, with a comma");
    expect(second.start).toBe(5500);
    expect(second.end).toBe(7250);
  });

  it("drops cues whose text is empty after cleanup", () => {
    const texts = parseAss(SAMPLE).map((c) => c.text);
    expect(texts).not.toContain("");
  });

  it("falls back to canonical column order without a Format header", () => {
    const body = [
      "[Events]",
      "Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,No format header",
    ].join("\n");
    expect(parseAss(body)).toEqual([
      { start: 2000, end: 4000, text: "No format header" },
    ]);
  });

  it("returns cues sorted ascending by start", () => {
    const body = [
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,later",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,earlier",
    ].join("\n");
    expect(parseAss(body).map((c) => c.text)).toEqual(["earlier", "later"]);
  });

  it("handles \\r\\n line endings", () => {
    const body =
      "[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,crlf cue\r\n";
    expect(parseAss(body)).toEqual([
      { start: 1000, end: 2000, text: "crlf cue" },
    ]);
  });

  it("ignores Dialogue-like lines outside [Events]", () => {
    const body = [
      "[Script Info]",
      "Dialogue: not a real event line",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,real",
    ].join("\n");
    expect(parseAss(body)).toEqual([
      { start: 1000, end: 2000, text: "real" },
    ]);
  });
});
