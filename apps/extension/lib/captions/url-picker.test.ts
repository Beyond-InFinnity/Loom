import { describe, it, expect } from "vitest";
import { pickPotBearingUrl, type CapturedReqMin } from "./url-picker";

const req = (
  order: number,
  url: string,
  potLen: number,
): CapturedReqMin => ({ order, url, params: { potLen } });

describe("pickPotBearingUrl", () => {
  it("returns null on empty array", () => {
    expect(pickPotBearingUrl([])).toBeNull();
  });

  it("returns null when no captured request has a pot", () => {
    const arr = [req(0, "no-pot-0", 0), req(1, "no-pot-1", 0)];
    expect(pickPotBearingUrl(arr)).toBeNull();
  });

  it("returns the first pot-bearing URL when one is present", () => {
    const arr = [
      req(0, "no-pot-0", 0),
      req(1, "good-pot", 112),
      req(2, "later-pot", 112),
    ];
    expect(pickPotBearingUrl(arr)?.order).toBe(1);
  });

  // The 5c regression's load-bearing case: user manually toggles YT's
  // own CC button AFTER our extension already captured a good pot
  // URL.  YT's manual-toggle refetches lack pot.  Last-write-wins
  // picked the no-pot URL; the array-based first-pot picker rejects
  // it and keeps the earlier pot URL.
  it("user-click resilience: a later no-pot URL does not replace an earlier pot URL", () => {
    const arr = [
      req(0, "natural-prefetch-pot", 112),
      req(1, "user-clicked-cc-no-pot", 0),
      req(2, "user-clicked-cc-no-pot-2", 0),
    ];
    const picked = pickPotBearingUrl(arr);
    expect(picked?.order).toBe(0);
    expect(picked?.url).toBe("natural-prefetch-pot");
  });

  it("picks the earliest pot URL even if later pot URLs also exist", () => {
    const arr = [
      req(0, "first-pot", 112),
      req(1, "no-pot-middle", 0),
      req(2, "later-pot", 112),
    ];
    expect(pickPotBearingUrl(arr)?.order).toBe(0);
  });

  // Expiry (the "previously-watched videos break" bug): the persistent
  // MV2 background keeps a stale first-watch URL; a fresh re-watch URL is
  // appended after it. First-pot-by-order returned the expired one (→ 404).
  const NOW = 2_000_000_000_000; // fixed clock for deterministic tests
  const expireParam = (unixSeconds: number) =>
    `https://yt/api/timedtext?lang=zh&pot=abc&expire=${unixSeconds}`;

  it("skips an expired pot URL in favor of a later non-expired pot URL", () => {
    const stale = Math.floor(NOW / 1000) - 3600; // expired 1h ago
    const fresh = Math.floor(NOW / 1000) + 3600; // valid for 1h
    const arr = [
      req(0, expireParam(stale), 112), // first-watch, now expired
      req(1, expireParam(fresh), 112), // re-watch, fresh
    ];
    const picked = pickPotBearingUrl(arr, NOW);
    expect(picked?.order).toBe(1);
  });

  it("keeps the first pot URL when its expire is still in the future", () => {
    const fresh = Math.floor(NOW / 1000) + 3600;
    const arr = [
      req(0, expireParam(fresh), 112),
      req(1, expireParam(fresh), 112),
    ];
    expect(pickPotBearingUrl(arr, NOW)?.order).toBe(0);
  });

  it("never skips a pot URL that has no expire param (back-compat)", () => {
    const arr = [req(0, "first-pot-no-expire", 112), req(1, "later-pot", 112)];
    expect(pickPotBearingUrl(arr, NOW)?.order).toBe(0);
  });

  it("falls back to the first pot URL when every pot URL is expired", () => {
    const stale = Math.floor(NOW / 1000) - 3600;
    const arr = [
      req(0, expireParam(stale), 112),
      req(1, expireParam(stale), 112),
    ];
    // No fresh sibling exists; least-bad is the prior first-pot behavior.
    expect(pickPotBearingUrl(arr, NOW)?.order).toBe(0);
  });

  it("preserves the full original shape via the type parameter", () => {
    // Picker accepts wider shapes (e.g., background's CapturedReq) and
    // returns the original element by reference — no field loss.
    interface Wide extends CapturedReqMin {
      tMs: number;
      urlLen: number;
    }
    const arr: Wide[] = [
      { order: 0, url: "a", params: { potLen: 0 }, tMs: 10, urlLen: 100 },
      { order: 1, url: "b", params: { potLen: 50 }, tMs: 20, urlLen: 200 },
    ];
    const picked = pickPotBearingUrl(arr);
    expect(picked?.tMs).toBe(20);
    expect(picked?.urlLen).toBe(200);
  });
});
