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
