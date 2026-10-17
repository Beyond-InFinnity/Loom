import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = { firefox: "firefox-mv2", chrome: "chrome-mv3" };

// Keep all manifest fields and array ordering. Only the release version can
// change without reviewing the snapshot (permissions, hosts, scripts, etc.).
export function checkManifest(actual, expected, version) {
  assert.equal(actual.version, version, "manifest version must match extension package");
  const { version: ignored, ...manifest } = actual;
  assert.deepStrictEqual(manifest, expected, "production manifest changed; review its snapshot diff");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  assert.ok(Object.hasOwn(targets, target), "usage: node scripts/check-extension-manifest.mjs firefox|chrome [manifest.json]");
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const actualPath = process.argv[3] ?? resolve(root, "apps/extension/.output", targets[target], "manifest.json");
  const expected = read(resolve(root, "apps/extension/manifest-snapshots", `${target}.json`));
  const { version } = read(resolve(root, "apps/extension/package.json"));
  checkManifest(read(actualPath), expected, version);
  console.log(`${target}: production manifest matches reviewed snapshot`);
}
