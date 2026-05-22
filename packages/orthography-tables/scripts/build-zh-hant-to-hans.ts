// Builder: Traditional Chinese → Simplified Chinese single-character map.
//
// Source: OpenCC `TSCharacters.txt`.  Loom already depends on OpenCC
// (loom_core uses it for the zh-Hant → zh-Hans pre-tokenization step in
// Pinyin generation), so we reuse its dict rather than introducing a
// second source.  Unihan kSimplifiedVariant could cross-check gaps but
// OpenCC's dict is the authoritative source-of-truth.
//
// File format (per line):
//   <trad>\t<simp>
//   <trad>\t<simp1> <simp2> <simp3>     (multi-target; first is canonical)
//
// Rules applied here:
//   1. Take the FIRST space-separated target as the canonical mapping.
//      Subsequent alternates are context-dependent and out-of-scope.
//   2. SKIP rows where the canonical target equals the source — the
//      char is unchanged across the orthography pair, so we don't
//      annotate or highlight it.
//   3. Compute `collapse`: invert the to→source multimap; each entry's
//      collapse is (everyone sharing this `to`) minus self.
//   4. Sort keys lexicographically for stable diffs.
//
// Source path resolution:
//   1. `--source <path>` CLI arg
//   2. LOOM_OPENCC_DICT_DIR env (directory holding TSCharacters.txt)
//   3. Default: apps/desktop/src-tauri/resources/python/venv/.../opencc/dictionary/
//      (gitignored bundle dir; available locally after setup_bundle.sh)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OrthographyEntry, OrthographyTable } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const OUT_PATH = join(PACKAGE_ROOT, "data", "zh-hant-to-hans.json");

const DEFAULT_OPENCC_DICT = join(
  REPO_ROOT,
  "apps/desktop/src-tauri/resources/python/venv/lib/python3.11/site-packages/opencc/dictionary/TSCharacters.txt",
);

function resolveSourcePath(): string {
  const argv = process.argv.slice(2);
  const sourceFlagIdx = argv.indexOf("--source");
  if (sourceFlagIdx >= 0 && argv[sourceFlagIdx + 1]) {
    return resolve(argv[sourceFlagIdx + 1]!);
  }
  const envDir = process.env.LOOM_OPENCC_DICT_DIR;
  if (envDir) {
    return join(envDir, "TSCharacters.txt");
  }
  return DEFAULT_OPENCC_DICT;
}

function build(): { table: OrthographyTable; stats: BuildStats } {
  const sourcePath = resolveSourcePath();
  if (!existsSync(sourcePath)) {
    throw new Error(
      `OpenCC TSCharacters.txt not found at ${sourcePath}.\n` +
        `  Provide a path via --source <path> or LOOM_OPENCC_DICT_DIR env.\n` +
        `  Default location is populated by apps/desktop's setup_bundle.sh.`,
    );
  }

  const raw = readFileSync(sourcePath, "utf-8");
  const lines = raw.split("\n");

  // Pass 1: forward dict { trad: canonical-simp }.
  const forward: Record<string, string> = {};
  let totalRows = 0;
  let skippedSame = 0;
  let skippedMalformed = 0;

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 2) {
      skippedMalformed++;
      continue;
    }
    totalRows++;
    const source = parts[0]!;
    const targets = parts[1]!.trim().split(/\s+/).filter(Boolean);
    if (targets.length === 0) {
      skippedMalformed++;
      continue;
    }
    const canonical = targets[0]!;
    if (canonical === source) {
      // "彷	彷 仿" — preferred form is the original; not an orthography
      // change.  Reader of either orthography sees the same glyph.
      skippedSame++;
      continue;
    }
    forward[source] = canonical;
  }

  // Pass 2: invert to compute collapse groups.
  const reverse: Record<string, string[]> = {};
  for (const [src, tgt] of Object.entries(forward)) {
    (reverse[tgt] ??= []).push(src);
  }

  // Pass 3: emit entries sorted by source codepoint.
  const sortedSources = Object.keys(forward).sort();
  const table: OrthographyTable = {};
  let collapseCount = 0;
  for (const src of sortedSources) {
    const tgt = forward[src]!;
    const siblings = reverse[tgt]!.filter((s) => s !== src).sort();
    const entry: OrthographyEntry = { to: tgt, collapse: siblings };
    if (siblings.length > 0) collapseCount++;
    table[src] = entry;
  }

  return {
    table,
    stats: {
      sourcePath,
      totalRows,
      skippedSame,
      skippedMalformed,
      tableEntries: sortedSources.length,
      collapseEntries: collapseCount,
    },
  };
}

interface BuildStats {
  sourcePath: string;
  totalRows: number;
  skippedSame: number;
  skippedMalformed: number;
  tableEntries: number;
  collapseEntries: number;
}

function main(): void {
  const { table, stats } = build();
  // Compact JSON keeps the file small without sacrificing diff stability
  // (keys are sorted; only end-of-line changes when a single entry changes).
  // Each entry on its own line for diff-friendliness.
  const lines: string[] = ["{"];
  const sources = Object.keys(table);
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    const entry = table[src]!;
    const trailing = i === sources.length - 1 ? "" : ",";
    lines.push(`  ${JSON.stringify(src)}: ${JSON.stringify(entry)}${trailing}`);
  }
  lines.push("}");
  lines.push("");
  writeFileSync(OUT_PATH, lines.join("\n"), "utf-8");

  console.log(`[orthography-tables] Built zh-hant-to-hans:`);
  console.log(`  source:           ${stats.sourcePath}`);
  console.log(`  total rows read:  ${stats.totalRows}`);
  console.log(`  skipped (same):   ${stats.skippedSame}`);
  console.log(`  skipped (bad):    ${stats.skippedMalformed}`);
  console.log(`  table entries:    ${stats.tableEntries}`);
  console.log(`  with collapse:    ${stats.collapseEntries}`);
  console.log(`  output:           ${OUT_PATH}`);
}

main();
