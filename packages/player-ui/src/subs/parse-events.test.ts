import { describe, expect, it } from "vitest";
import { parseSubtitleEvents } from "./parse-events";

const ASS = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}こんにちは{\\i0}、世界
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,二行目\\Nです
Dialogue: 0,0:00:07.00,0:00:08.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}
Dialogue: 0,0:00:09.00,0:00:08.00,Default,,0,0,0,,negative duration dropped
`;

const SRT = `1
00:00:01,500 --> 00:00:03,000
<i>Hello</i>, world

2
00:00:04,000 --> 00:00:06,000
Second line
continues
`;

const VTT = `WEBVTT

NOTE this is a comment

00:01.500 --> 00:03.000 line:10%
Styled <b>cue</b>

00:04.000 --> 00:06.000
Plain cue
`;

describe("parseSubtitleEvents", () => {
  it("parses ASS dialogue with tag stripping, \\N, and field order", () => {
    const evs = parseSubtitleEvents(ASS);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toEqual({ start: 1500, end: 3000, text: "こんにちは、世界" });
    expect(evs[1].text).toBe("二行目\nです");
  });

  it("drops drawing-mode and inverted-duration ASS events", () => {
    const texts = parseSubtitleEvents(ASS).map((e) => e.text);
    expect(texts.some((t) => t.includes("m 0 0"))).toBe(false);
    expect(texts.some((t) => t.includes("negative"))).toBe(false);
  });

  it("keeps commas inside ASS text (last-field split)", () => {
    const withComma = ASS.replace("こんにちは{\\i0}、世界", "a, b, c");
    const evs = parseSubtitleEvents(withComma);
    expect(evs[0].text).toBe("a, b, c");
  });

  it("parses SRT with markup stripping and multi-line cues", () => {
    const evs = parseSubtitleEvents(SRT);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toEqual({ start: 1500, end: 3000, text: "Hello, world" });
    expect(evs[1].text).toBe("Second line\ncontinues");
  });

  it("parses VTT with header/NOTE skipping and cue settings", () => {
    const evs = parseSubtitleEvents(VTT);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toEqual({ start: 1500, end: 3000, text: "Styled cue" });
  });

  it("returns [] for unrecognized content", () => {
    expect(parseSubtitleEvents("not a subtitle file")).toEqual([]);
  });
});
