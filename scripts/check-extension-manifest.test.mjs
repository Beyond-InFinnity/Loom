import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkManifest } from "./check-extension-manifest.mjs";

for (const browser of ["firefox", "chrome"]) {
  const expected = JSON.parse(readFileSync(new URL(`../apps/extension/manifest-snapshots/${browser}.json`, import.meta.url)));
  const actual = () => ({ ...structuredClone(expected), version: "0.5.2" });

  test(`${browser}: accepts a version bump matching package.json`, () => {
    checkManifest(actual(), expected, "0.5.2");
  });
  test(`${browser}: rejects a stale artifact version`, () => {
    assert.throws(() => checkManifest(actual(), expected, "0.5.3"));
  });
  test(`${browser}: rejects a development API override`, () => {
    const manifest = actual();
    const field = browser === "firefox" ? "permissions" : "host_permissions";
    manifest[field] = manifest[field].map((host) => host === "https://api.loom.nerv-analytic.ai/*" ? "http://localhost:8000/*" : host);
    assert.throws(() => checkManifest(manifest, expected, "0.5.2"));
  });
  test(`${browser}: rejects added privileges`, () => {
    const manifest = actual();
    manifest.permissions.push("tabs");
    assert.throws(() => checkManifest(manifest, expected, "0.5.2"));
  });
  test(`${browser}: rejects changed execution worlds and unexpected fields`, () => {
    const manifest = actual();
    manifest.content_scripts.find((script) => script.world === "MAIN").world = "ISOLATED";
    assert.throws(() => checkManifest(manifest, expected, "0.5.2"));
    assert.throws(() => checkManifest({ ...actual(), externally_connectable: { matches: ["<all_urls>"] } }, expected, "0.5.2"));
  });
}

test("Firefox: rejects removal of the consent-compatible version floor", () => {
  const expected = JSON.parse(readFileSync(new URL("../apps/extension/manifest-snapshots/firefox.json", import.meta.url)));
  const manifest = { ...structuredClone(expected), version: "0.5.2" };
  delete manifest.browser_specific_settings.gecko.strict_min_version;
  assert.throws(() => checkManifest(manifest, expected, "0.5.2"));
});
