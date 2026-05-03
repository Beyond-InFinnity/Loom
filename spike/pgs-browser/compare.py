#!/usr/bin/env python3
"""Drive index.html via Playwright, capture the browser-side canvas
output, and pixel-diff it against the Playwright reference.

This is spike-2 + spike-3 in one runnable artifact.  No manual browser
steps required.

Outputs:
  browser.png   — canvas → PNG download from index.html
  browser.bin   — raw 1920×1080 RGBA from canvas getImageData
  diff.png      — per-pixel max-channel-delta heatmap (red = high)
  stats.txt     — pixel-diff statistics

Run (after make_reference.py has produced reference.bin):
  cd spike/pgs-browser && python compare.py

Expected duration: ~30s
  * http.server boot: <1s
  * Playwright Chromium cold-start: ~10–15s
  * page load + 2 font fetches (~5MB each): ~3s
  * SVG build + drawImage + getImageData: ~2s
  * pixel diff: ~2s
"""
import asyncio
import base64
import socket
import subprocess
import sys
import time
from pathlib import Path

SPIKE_DIR = Path(__file__).parent
REPO_ROOT = SPIKE_DIR.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from playwright.async_api import async_playwright

W, H = 1920, 1080
PORT = 8001


def _start_server() -> subprocess.Popen:
    print(f"[1/5] starting http.server on :{PORT}")
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT)],
        cwd=SPIKE_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # Wait until the port accepts connections (max 5s).
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
                print(f"      ready in {(5 - (deadline - time.time())):.2f}s")
                return proc
        except OSError:
            time.sleep(0.05)
    proc.terminate()
    sys.exit(f"[error] http.server didn't accept on :{PORT} within 5s")


async def _drive_browser():
    async with async_playwright() as p:
        print("[2/5] launching headless Chromium (cold-start ~10s)")
        t0 = time.time()
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": W, "height": H},
                                        device_scale_factor=1)
        page = await ctx.new_page()

        # Surface page console + errors so silent failures aren't silent.
        console_lines = []
        page.on("console", lambda msg: console_lines.append(f"  [console.{msg.type}] {msg.text}"))
        page.on("pageerror", lambda e: console_lines.append(f"  [pageerror] {e}"))

        await page.goto(f"http://127.0.0.1:{PORT}/index.html",
                        wait_until="domcontentloaded")
        print(f"      page loaded in {time.time()-t0:.1f}s")

        print("[3/5] triggering capture (click + wait for status .ok)")
        await page.click("#run")
        # Wait for the status div to flip to .ok or .err.  Long timeout —
        # inlining 2× ~5MB fonts + drawImage can take several seconds on
        # a cold browser.
        await page.wait_for_function(
            "document.getElementById('status').classList.contains('ok') || "
            "document.getElementById('status').classList.contains('err')",
            timeout=30_000,
        )
        status_text = await page.locator("#status").text_content()
        status_class = await page.locator("#status").get_attribute("class")
        print(f"      status: {status_text!r}")
        if "err" in (status_class or ""):
            log = await page.locator("#log").text_content()
            print("\n--- page log ---")
            print(log)
            print("\n--- console ---")
            for line in console_lines:
                print(line)
            sys.exit("[error] browser-side capture failed")

        print("[4/5] extracting canvas as PNG + raw RGBA")
        # canvas.toDataURL → strip "data:image/png;base64," prefix → write bytes
        png_data_url = await page.evaluate("document.getElementById('canvas').toDataURL('image/png')")
        png_bytes = base64.b64decode(png_data_url.split(",", 1)[1])
        (SPIKE_DIR / "browser.png").write_bytes(png_bytes)
        print(f"      browser.png: {len(png_bytes):,} bytes")

        # getImageData returns a Uint8ClampedArray of length W*H*4.  Pull
        # it back as a JS array → Python bytes.  Slow (~32MB transfer)
        # but reliable.
        rgba_b64 = await page.evaluate("""() => {
            const ctx = document.getElementById('canvas').getContext('2d');
            const data = ctx.getImageData(0, 0, %d, %d).data;
            // Encode to base64 in browser to avoid serialization overhead
            // of a 8MB Uint8ClampedArray.
            let bin = '';
            const chunk = 0x8000;
            for (let i = 0; i < data.length; i += chunk) {
                bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
            }
            return btoa(bin);
        }""" % (W, H))
        rgba_bytes = base64.b64decode(rgba_b64)
        (SPIKE_DIR / "browser.bin").write_bytes(rgba_bytes)
        print(f"      browser.bin: {len(rgba_bytes):,} bytes ({W}×{H} RGBA)")

        await browser.close()
        if console_lines:
            print("\n--- page console (informational) ---")
            for line in console_lines:
                print(line)


def _diff():
    print("[5/5] pixel-diff browser.bin vs reference.bin")
    ref = (SPIKE_DIR / "reference.bin").read_bytes()
    bro = (SPIKE_DIR / "browser.bin").read_bytes()
    if len(ref) != len(bro):
        sys.exit(f"[error] size mismatch: ref={len(ref)} browser={len(bro)}")

    # Channel-by-channel deltas across the whole buffer.
    import numpy as np
    ref_arr = np.frombuffer(ref, dtype=np.uint8).reshape(H, W, 4)
    bro_arr = np.frombuffer(bro, dtype=np.uint8).reshape(H, W, 4)
    delta = np.abs(ref_arr.astype(np.int16) - bro_arr.astype(np.int16)).astype(np.uint8)

    # Per-pixel max delta across RGBA channels.
    max_per_pixel = delta.max(axis=2)

    total_pixels = W * H
    differing = int((max_per_pixel > 0).sum())
    differing_pct = 100 * differing / total_pixels
    max_delta = int(max_per_pixel.max())
    mean_delta = float(max_per_pixel.mean())
    p99_delta = int(np.percentile(max_per_pixel, 99))

    # Histogram of max deltas (just the >0 cases — most pixels are
    # background-identical).
    nonzero = max_per_pixel[max_per_pixel > 0]
    if len(nonzero) > 0:
        hist, _ = np.histogram(nonzero, bins=[1, 5, 10, 25, 50, 100, 256])
        hist_str = (
            f"\n      delta histogram (non-zero pixels only):\n"
            f"        1-4:   {int(hist[0]):>10,}\n"
            f"        5-9:   {int(hist[1]):>10,}\n"
            f"        10-24: {int(hist[2]):>10,}\n"
            f"        25-49: {int(hist[3]):>10,}\n"
            f"        50-99: {int(hist[4]):>10,}\n"
            f"        100+:  {int(hist[5]):>10,}"
        )
    else:
        hist_str = "\n      delta histogram: (no differing pixels)"

    report = (
        f"Pixel diff: browser canvas vs Playwright reference\n"
        f"  total pixels:           {total_pixels:>10,}\n"
        f"  differing pixels:       {differing:>10,}  ({differing_pct:.3f}%)\n"
        f"  max channel delta:      {max_delta:>10}/255\n"
        f"  mean max-channel delta: {mean_delta:>10.3f}\n"
        f"  p99 max-channel delta:  {p99_delta:>10}/255"
        f"{hist_str}\n"
    )
    print(report)
    (SPIKE_DIR / "stats.txt").write_text(report)

    # Visual diff: red where pixels differ, intensity scaled by delta.
    from PIL import Image
    diff_rgba = np.zeros((H, W, 4), dtype=np.uint8)
    diff_rgba[..., 0] = max_per_pixel  # red channel = delta intensity
    diff_rgba[..., 3] = (max_per_pixel > 0).astype(np.uint8) * 255  # alpha mask
    Image.fromarray(diff_rgba, mode="RGBA").save(SPIKE_DIR / "diff.png")
    print(f"      diff.png written ({differing:,} red pixels marking differences)")

    # Verdict — what would PGS palette quantization make of this?
    # Typical PGS palettes are 256 colors and ~3-5 bits per channel of
    # effective resolution after quantization.  Deltas under ~16/255 will
    # almost always collapse to the same palette entry.
    print()
    if max_delta <= 16 and differing_pct < 5:
        print("VERDICT: ✅ PIXEL-PARITY (after quantization).  Browser canvas")
        print("         output is functionally identical to Playwright reference")
        print("         once palette-quantized.  Option B is viable.")
    elif max_delta <= 32 and differing_pct < 10:
        print("VERDICT: 🟡 CLOSE.  Some anti-aliasing / subpixel deltas.  Likely")
        print("         still palette-equivalent but warrants checking the actual")
        print("         quantized indices in the next phase.")
    else:
        print("VERDICT: ❌ SIGNIFICANT DIVERGENCE.  Browser canvas output differs")
        print("         enough from Playwright reference that PGS palette")
        print("         quantization will likely produce different indices.")
        print("         Investigate root cause before committing to Option B.")


async def main():
    server = _start_server()
    try:
        await _drive_browser()
        _diff()
    finally:
        print("\n[cleanup] stopping http.server")
        server.terminate()
        server.wait(timeout=2)


if __name__ == "__main__":
    asyncio.run(main())
