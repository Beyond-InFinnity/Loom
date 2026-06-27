import { describe, expect, it } from "vitest";

import { parseM3u8Segments } from "./parse-m3u8";

const BASE = "https://cffaws.wetvinfo.com/svp_50217/abc/gzc_x.f53102001.vtt.m3u8?ver=4";

describe("parseM3u8Segments", () => {
  it("returns [] for a non-playlist (e.g. raw WebVTT)", () => {
    expect(parseM3u8Segments("WEBVTT\n\n1\n00:00.000 --> 00:01.000\nhi", BASE)).toEqual(
      [],
    );
  });

  it("extracts a single relative segment resolved against the playlist URL", () => {
    const pl = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:99999",
      "#EXTINF:99999,",
      "gzc_x.f53102001.vtt?ver=4",
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(parseM3u8Segments(pl, BASE)).toEqual([
      "https://cffaws.wetvinfo.com/svp_50217/abc/gzc_x.f53102001.vtt?ver=4",
    ]);
  });

  it("extracts multiple segments in order, skipping all #-tag lines", () => {
    const pl = [
      "#EXTM3U",
      "#EXTINF:10,",
      "seg0.vtt",
      "#EXTINF:10,",
      "seg1.vtt",
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(parseM3u8Segments(pl, BASE)).toEqual([
      "https://cffaws.wetvinfo.com/svp_50217/abc/seg0.vtt",
      "https://cffaws.wetvinfo.com/svp_50217/abc/seg1.vtt",
    ]);
  });

  it("passes absolute segment URLs through unchanged", () => {
    const pl = ["#EXTM3U", "https://cdn.example.com/x/seg.vtt?t=1"].join("\n");
    expect(parseM3u8Segments(pl, BASE)).toEqual([
      "https://cdn.example.com/x/seg.vtt?t=1",
    ]);
  });

  it("tolerates CRLF line endings and blank lines", () => {
    const pl = "#EXTM3U\r\n\r\n#EXTINF:5,\r\nseg.vtt\r\n";
    expect(parseM3u8Segments(pl, BASE)).toEqual([
      "https://cffaws.wetvinfo.com/svp_50217/abc/seg.vtt",
    ]);
  });
});
