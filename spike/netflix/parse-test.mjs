// Smoke test for the Netflix subtitle parse path (recon Step 5).
//
//   node spike/netflix/parse-test.mjs
//
// Runs the VTT + TTML parsers against the synthetic samples, asserts the
// CaptionEvent contract (ms times, tag/entity stripping, multi-line, sort),
// asserts VTT/TTML parity on identical cues, and asserts image-based TTML is
// detected and yields zero events. Exits non-zero on any failure so it can
// gate CI later. Point it at a real capture by replacing the sample files.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseVtt, vttTimeToMs } from "./parse-vtt.mjs";
import { parseTtml, ttmlTimeToMs } from "./parse-ttml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\nWebVTT parser");
const vtt = parseVtt(read("sample-subs-ja.vtt"));
check("event count == 5", vtt.length === 5, `got ${vtt.length}`);
check("first start == 6473ms", vtt[0]?.start === 6473, `got ${vtt[0]?.start}`);
check("first end == 10443ms", vtt[0]?.end === 10443, `got ${vtt[0]?.end}`);
check("inline <c.*> tag stripped", vtt[0]?.text === "おはよう、東京。", JSON.stringify(vtt[0]?.text));
check("inline <i> tag stripped", vtt[1]?.text === "今日はいい天気ですね。", JSON.stringify(vtt[1]?.text));
check("multi-line cue keeps newline", vtt[2]?.text === "電車が来ました。\n急ぎましょう！", JSON.stringify(vtt[2]?.text));
check("&lrm; bidi mark dropped", vtt[3]?.text === "ありがとう。", JSON.stringify(vtt[3]?.text));
check("MM:SS timestamp (62.25s)", vtt[4]?.start === 62250, `got ${vtt[4]?.start}`);
check("sorted ascending by start", vtt.every((e, i) => i === 0 || vtt[i - 1].start <= e.start));
check("count looks like a real episode? (informational)", true, `${vtt.length} cues (a 50-min ep ≈ 500–1500)`);

console.log("\nWebVTT parser — REAL capture format (PH region, ja CC track, 2026-06-18)");
// Head of a real netflix-ja.vtt (webvtt-lssdh-ios8) captured live via
// capture-kit.js. Exercises the format quirks the synthetic sample lacks:
// NOTE Netflix / Profile / SegmentIndex header blocks, comma-bearing cue
// settings (position:50.00%,middle), <c.japanese>…</c.japanese> class tags,
// and inline furigana-in-parens — which we deliberately PRESERVE as text.
const real = parseVtt(read("sample-subs-ja-real.vtt"));
check("NOTE/SegmentIndex blocks skipped → exactly 4 cues", real.length === 4, `got ${real.length}`);
check("first start == 2085ms", real[0]?.start === 2085, `got ${real[0]?.start}`);
check("first end == 3920ms", real[0]?.end === 3920, `got ${real[0]?.end}`);
check(
  "<c.japanese> stripped, inline furigana parens kept",
  real[0]?.text === "（金田(かなだ)）おい 聞いてんのか？",
  JSON.stringify(real[0]?.text),
);
check(
  "comma cue setting (position:..,middle) doesn't corrupt end ts",
  real[1]?.start === 4754 && real[1]?.end === 8383,
  `${real[1]?.start}/${real[1]?.end}`,
);
check(
  "multi-line cue keeps newline",
  real[1]?.text === "だから 開きっぱなしなんだよ\nオートロックのドアが！",
  JSON.stringify(real[1]?.text),
);

console.log("\nWebVTT parser — REAL Korean SDH/CC track (Squid Game, nested class tags)");
// Head of a real netflix-ko.vtt (webvtt-lssdh-ios8, closedcaptions/SDH track).
// Exercises NESTED class wrappers <c.korean><c.bg_transparent>…</c.bg_transparent></c.korean>
// and SDH non-speech brackets ([음산한 음악]) — both must survive: tags fully
// stripped, bracketed text + "- " dialogue dashes preserved verbatim.
const ko = parseVtt(read("sample-subs-ko-real.vtt"));
check("nested-tag cues → exactly 2", ko.length === 2, `got ${ko.length}`);
check("first start == 13972ms", ko[0]?.start === 13972, `got ${ko[0]?.start}`);
check(
  "nested <c.korean><c.bg_transparent> fully stripped, brackets+dashes kept",
  ko[0]?.text === "- [덜컹덜컹]\n- [지게차 경보음]",
  JSON.stringify(ko[0]?.text),
);
check(
  "single SDH bracket cue preserved",
  ko[1]?.text === "[음산한 음악]",
  JSON.stringify(ko[1]?.text),
);

console.log("\nTTML / DFXP parser (fallback path)");
const { events: ttml, imageBased } = parseTtml(read("sample-subs-ja.ttml"));
check("event count == 5", ttml.length === 5, `got ${ttml.length}`);
check("not flagged image-based", imageBased === false);
check("tick time → 6473ms", ttml[0]?.start === 6473, `got ${ttml[0]?.start}`);
check("tick time → 10443ms", ttml[0]?.end === 10443, `got ${ttml[0]?.end}`);
check("<span> stripped", ttml[1]?.text === "今日はいい天気ですね。", JSON.stringify(ttml[1]?.text));
check("<br/> → newline", ttml[2]?.text === "電車が来ました。\n急ぎましょう！", JSON.stringify(ttml[2]?.text));

console.log("\nVTT/TTML parity (same cues, both formats)");
check("identical start/end/text across all 5 cues", eq(vtt, ttml));

console.log("\nImage-based TTML detection");
const img = parseTtml(read("sample-subs-image.ttml"));
check("imageBased == true", img.imageBased === true);
check("zero text events extracted", img.events.length === 0, `got ${img.events.length}`);

console.log("\nUnit: time parsers");
check("vttTimeToMs HH:MM:SS.mmm", vttTimeToMs("01:02:03.456") === 3723456);
check("vttTimeToMs MM:SS.mmm", vttTimeToMs("02:03.456") === 123456);
check("ttmlTimeToMs ticks", ttmlTimeToMs("650000000t", { tickRate: 10000000 }) === 65000);
check("ttmlTimeToMs offset s", ttmlTimeToMs("65.0s") === 65000);
check("ttmlTimeToMs clock+frac", ttmlTimeToMs("00:01:05.000") === 65000);

console.log(`\n${failures === 0 ? "✓ ALL PASSED" : `✗ ${failures} FAILED`}\n`);
process.exit(failures ? 1 : 0);
