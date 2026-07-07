import { describe, it, expect } from "vitest";
import {
  parseTtml,
  ttmlTimeToMs,
  ttmlLang,
  rubyTextStyleIds,
  decodeEntities,
} from "./parse-ttml";

// Synthetic TTML2 fixture modeled EXACTLY on the real Prime capture
// (Evangelion 3.33, recon 2026-07-07) — same styling map (s4 ruby base,
// s5/s7 ruby text before/after), same <p begin= end=> clock timing,
// authored furigana, <br/> line breaks, parenthetical speaker labels,
// tate-chu-yoko (s9 textCombine), and a vertical-writing region.  Real
// dialogue is NOT committed (copyright); these are invented lines that
// exercise every structural feature the parser handles.
const FIXTURE = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:tts="http://www.w3.org/ns/ttml#styling" ttp:version="2" xml:lang="jp">
 <head>
  <styling>
   <initial tts:fontSize="4vh" />
   <style tts:textAlign="center" xml:id="s1"></style>
   <style tts:textAlign="start" xml:id="s2"></style>
   <style tts:ruby="container" xml:id="s3"></style>
   <style tts:ruby="base" xml:id="s4"></style>
   <style tts:ruby="text" tts:rubyPosition="before" xml:id="s5"></style>
   <style tts:ruby="text" tts:rubyPosition="after" xml:id="s7"></style>
   <style tts:textCombine="all" xml:id="s9"></style>
  </styling>
  <layout>
   <region tts:displayAlign="after" tts:extent="80vw 15vh" xml:id="横下" />
   <region tts:extent="15vw 80vh" tts:writingMode="tbrl" xml:id="縦右" />
  </layout>
 </head>
 <body region="横下" xml:space="preserve">
  <div>
   <p begin="00:00:35.786" end="00:00:37.621" style="s1"><span style="s2">（無線のノイズ音）</span></p>
   <p begin="00:00:37.747" end="00:00:41.375" style="s1"><span style="s2">（<span style="s3"><span style="s4">青</span><span style="s5">あお</span></span><span style="s3"><span style="s4">葉</span><span style="s5">ば</span></span>）本部<br />応答せよ</span></p>
   <p begin="00:01:02.400" end="00:01:05.000" style="s1"><span style="s2">これは&amp;テスト&#12290;</span></p>
   <p begin="01:02:03.500" end="01:02:05.000" style="s1"><span style="s9">30</span>階だ</p>
  </div>
 </body>
</tt>`;

describe("ttmlTimeToMs", () => {
  it("parses HH:MM:SS.mmm", () => {
    expect(ttmlTimeToMs("00:00:37.747")).toBe(37747);
    expect(ttmlTimeToMs("01:02:03.500")).toBe(3723500);
  });
  it("parses MM:SS.mmm (no hours)", () => {
    expect(ttmlTimeToMs("02:05.250")).toBe(125250);
  });
  it("tolerates a missing fractional part", () => {
    expect(ttmlTimeToMs("00:00:05")).toBe(5000);
  });
  it("returns null on garbage", () => {
    expect(ttmlTimeToMs("nope")).toBeNull();
  });
});

describe("ttmlLang", () => {
  it("reads xml:lang off <tt>", () => {
    expect(ttmlLang(FIXTURE)).toBe("jp");
  });
  it("returns null when absent", () => {
    expect(ttmlLang("<tt><body/></tt>")).toBeNull();
  });
});

describe("rubyTextStyleIds", () => {
  it("finds every tts:ruby=text style id in <head>", () => {
    expect([...rubyTextStyleIds(FIXTURE)].sort()).toEqual(["s5", "s7"]);
  });
  it("ignores ruby=base and non-ruby styles", () => {
    const ids = rubyTextStyleIds(FIXTURE);
    expect(ids.has("s4")).toBe(false); // base
    expect(ids.has("s1")).toBe(false); // textAlign
  });
});

describe("decodeEntities", () => {
  it("decodes named + numeric entities", () => {
    expect(decodeEntities("a&amp;b")).toBe("a&b");
    expect(decodeEntities("&#12290;")).toBe("。");
    expect(decodeEntities("&#x3002;")).toBe("。");
  });
});

describe("parseTtml", () => {
  const ev = parseTtml(FIXTURE);

  it("extracts every timed <p> cue", () => {
    expect(ev.length).toBe(4);
  });

  it("converts begin/end to integer ms", () => {
    expect(ev[0]).toMatchObject({ start: 35786, end: 37621 });
  });

  it("DROPS ruby readings, keeping clean base text (青葉, not 青あお葉ば)", () => {
    const cue = ev[1].text;
    expect(cue).toContain("青葉");
    expect(cue).not.toContain("あお");
    expect(cue).not.toContain("青あお");
  });

  it("converts <br/> to newline", () => {
    expect(ev[1].text).toBe("（青葉）本部\n応答せよ");
  });

  it("decodes entities in cue text", () => {
    expect(ev[2].text).toBe("これは&テスト。");
  });

  it("keeps tate-chu-yoko digit text (textCombine span)", () => {
    expect(ev[3].text).toBe("30階だ");
  });

  it("leaves no residual markup", () => {
    expect(ev.every((e) => !/[<>]/.test(e.text))).toBe(true);
  });

  it("drops no cue to empty and sorts ascending", () => {
    expect(ev.every((e) => e.text.length > 0)).toBe(true);
    expect(ev.every((e, i) => i === 0 || ev[i - 1].start <= e.start)).toBe(true);
  });

  it("skips non-timed <p> and header blocks", () => {
    // A <p> with no begin/end must not appear.
    const withUntimed = FIXTURE.replace(
      "<div>",
      '<div><p style="s1">no timing here</p>',
    );
    expect(parseTtml(withUntimed).length).toBe(4);
  });

  it("returns [] on an empty / non-TTML body", () => {
    expect(parseTtml("")).toEqual([]);
    expect(parseTtml("<html><body>hi</body></html>")).toEqual([]);
  });
});

describe("parseTtml layout (positional / vertical)", () => {
  it("inherits the body region (横下) → horizontal, bottom, center", () => {
    const ev = parseTtml(FIXTURE);
    // Every cue in FIXTURE inherits <body region="横下"> (none override).
    for (const e of ev) {
      expect(e.layout).toBeDefined();
      expect(e.layout?.writingMode).toBe("horizontal");
      expect(e.layout?.block).toBe("bottom"); // tts:displayAlign="after"
      expect(e.layout?.inline).toBe("center");
      expect(e.layout?.regionId).toBe("横下");
      // 80vw 15vh extent (no origin) → not precisely placed.
      expect(e.layout?.origin).toBeUndefined();
      expect(e.layout?.extent).toEqual({ w: 0.8, h: 0.15 });
    }
  });

  it("resolves a per-cue vertical region (縦右) → vertical-rl, top, right", () => {
    const withVertical = FIXTURE.replace(
      "  </div>",
      '   <p begin="00:02:00.000" end="00:02:02.000" region="縦右" style="s1"><span style="s2">（シンジ）あ…</span></p>\n  </div>',
    );
    const ev = parseTtml(withVertical);
    const vcue = ev.find((e) => e.text.includes("シンジ"));
    expect(vcue).toBeDefined();
    expect(vcue?.layout?.writingMode).toBe("vertical-rl"); // tts:writingMode="tbrl"
    expect(vcue?.layout?.inline).toBe("right"); // 縦右 mnemonic
    expect(vcue?.layout?.block).toBe("top"); // vertical default (no coords/displayAlign)
    expect(vcue?.layout?.extent).toEqual({ w: 0.15, h: 0.8 });
  });

  it("uses precise tts:origin when the region defines it", () => {
    const doc = `<tt xmlns:tts="http://www.w3.org/ns/ttml#styling">
 <head><layout>
  <region tts:origin="60vw 5vh" tts:extent="35vw 30vh" xml:id="r1" />
 </layout></head>
 <body><div>
  <p begin="00:00:01.000" end="00:00:02.000" region="r1">hi</p>
 </div></body></tt>`;
    const ev = parseTtml(doc);
    expect(ev[0].layout?.origin).toEqual({ x: 0.6, y: 0.05 });
    // center (0.6+0.175, 0.05+0.15) = (0.775, 0.2) → right, top
    expect(ev[0].layout?.inline).toBe("right");
    expect(ev[0].layout?.block).toBe("top");
  });

  it("leaves layout undefined when the track has no regions", () => {
    const doc = `<tt><body><div>
  <p begin="00:00:01.000" end="00:00:02.000">plain</p>
 </div></body></tt>`;
    expect(parseTtml(doc)[0].layout).toBeUndefined();
  });
});
