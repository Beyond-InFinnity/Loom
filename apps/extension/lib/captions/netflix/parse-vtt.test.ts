import { describe, expect, it } from "vitest";

import { cleanText, decodeEntities, parseVtt, vttTimeToMs } from "./parse-vtt";

describe("vttTimeToMs", () => {
  it("parses HH:MM:SS.mmm", () => {
    expect(vttTimeToMs("01:02:03.456")).toBe(3723456);
  });
  it("parses MM:SS.mmm (no hours)", () => {
    expect(vttTimeToMs("02:03.456")).toBe(123456);
  });
  it("accepts comma decimal separator", () => {
    expect(vttTimeToMs("00:00:01,500")).toBe(1500);
  });
  it("returns null for garbage", () => {
    expect(vttTimeToMs("not a time")).toBeNull();
  });
});

describe("decodeEntities / cleanText", () => {
  it("decodes the named + numeric entities Netflix emits", () => {
    expect(decodeEntities("a &amp; b &#65; &#x42;")).toBe("a & b A B");
  });
  it("drops bidi-control entities", () => {
    expect(decodeEntities("x&lrm;y&rlm;z")).toBe("xyz");
  });
  it("strips inline tags and collapses runs of spaces", () => {
    expect(cleanText("<c.japanese>foo   bar</c.japanese>")).toBe("foo bar");
  });
});

describe("parseVtt", () => {
  it("skips WEBVTT/NOTE/SegmentIndex header + padding blocks", () => {
    const body = [
      "WEBVTT",
      "",
      "NOTE Netflix",
      "NOTE Profile: webvtt-lssdh-ios8",
      "",
      "NOTE SegmentIndex",
      "NOTE Segment=592.759 28255@350 168",
      "NOTE /SegmentIndex",
      "",
      "          ", // whitespace-only padding block
      "",
      "1",
      "00:00:02.085 --> 00:00:03.920 position:50.00%,middle align:middle size:80.00% line:84.67% ",
      "<c.japanese>（金田(かなだ)）おい 聞いてんのか？</c.japanese>",
    ].join("\n");
    const events = parseVtt(body);
    expect(events).toHaveLength(1);
    expect(events[0].start).toBe(2085);
    expect(events[0].end).toBe(3920);
    // <c.japanese> stripped; inline furigana-in-parens preserved.
    expect(events[0].text).toBe("（金田(かなだ)）おい 聞いてんのか？");
  });

  it("comma-bearing cue settings don't corrupt the end timestamp", () => {
    const body =
      "WEBVTT\n\n00:00:04.754 --> 00:00:08.383 position:50.00%,middle align:middle\nだから";
    const [e] = parseVtt(body);
    expect(e.start).toBe(4754);
    expect(e.end).toBe(8383);
  });

  it("keeps multi-line cues as newline-joined text", () => {
    const body =
      "WEBVTT\n\n00:00:04.754 --> 00:00:08.383\nだから 開きっぱなしなんだよ\nオートロックのドアが！";
    const [e] = parseVtt(body);
    expect(e.text).toBe("だから 開きっぱなしなんだよ\nオートロックのドアが！");
  });

  it("strips nested class wrappers but keeps SDH brackets + dialogue dashes", () => {
    const body =
      "WEBVTT\n\n00:00:13.972 --> 00:00:15.000\n<c.korean><c.bg_transparent>- [덜컹덜컹]\n- [지게차 경보음]</c.bg_transparent></c.korean>";
    const [e] = parseVtt(body);
    expect(e.text).toBe("- [덜컹덜컹]\n- [지게차 경보음]");
  });

  it("drops empty / whitespace-only cues", () => {
    const body =
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n   \n\n00:00:03.000 --> 00:00:04.000\nreal";
    const events = parseVtt(body);
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("real");
  });

  it("sorts ascending by start regardless of source order", () => {
    const body =
      "WEBVTT\n\n00:00:10.000 --> 00:00:11.000\nsecond\n\n00:00:01.000 --> 00:00:02.000\nfirst";
    const events = parseVtt(body);
    expect(events.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("handles CRLF line endings", () => {
    const body =
      "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhello\r\n";
    const [e] = parseVtt(body);
    expect(e.text).toBe("hello");
  });
});
