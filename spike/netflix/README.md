# Netflix port — recon spike

Artifacts for the `NETFLIX_RECON.md` go/no-go. Started 2026-05-28; recon
executed 2026-05-30. **Verdict: GO** (see `NETFLIX_RECON.md` Findings log).

## The one finding that changes the architecture

The recon doc assumed Netflix subtitle URLs could be grabbed by `webRequest`
interception of the manifest, like YouTube's `/timedtext`. **That is wrong.**
The Netflix manifest is fetched over **MSL (Message Security Layer)** and is
**encrypted on the wire** (`Content-Encoding: msl_v1`) — a `webRequest`
listener sees an opaque blob, not JSON.

The player decrypts MSL *in-page* and calls `JSON.parse()` on the result.
So the universal technique (Subadub, Language Reactor, the GreasyFork
downloader all do exactly this) is to **monkey-patch `JSON.parse` in the MAIN
world** and catch the object whose shape is `{ result: { movieId,
timedtexttracks } }`, plus patch `JSON.stringify` to inject the
`webvtt-lssdh-ios8` profile into the outgoing request so WebVTT URLs come back.

Net effect for Loom: **simpler** than YouTube. No `background.ts` webRequest
observer, no pot-token first-wins picker, no CC-toggle trigger. One MAIN-world
script that owns both the player API and the manifest hook. The downloaded
WebVTT URLs are plain unauthenticated GETs (signed, ~12 h expiry) — fetch and
cache immediately.

## Files

| File | What it is |
|---|---|
| `parse-vtt.mjs` | WebVTT → `CaptionEvent[]` (primary). Output contract mirrors `apps/extension/lib/captions/fanout.ts::parseJson3` exactly. |
| `parse-ttml.mjs` | TTML/DFXP → `{ events, imageBased }` (fallback). Detects image-based (bitmap) tracks. |
| `parse-test.mjs` | Smoke test — `node spike/netflix/parse-test.mjs`. 24 assertions; exits non-zero on failure. |
| `sample-subs-ja.{vtt,ttml}` | **Synthetic** (hand-authored) samples, same 5 cues both formats. Replace with a real capture. |
| `sample-subs-image.ttml` | **Synthetic** image-based track — proves the OCR-only detection. |
| `capture-kit.js` | Paste into the Netflix DevTools Console to capture a real manifest + sample VTT + probe the player API/DOM. |

## Run the parser test

```
node spike/netflix/parse-test.mjs
```

## Capture real data (needs an authenticated Netflix session — owner step)

The parsers are validated against synthetic samples. To validate on real
Netflix data and lock the production parser:

1. Open a Netflix title page (don't press play yet); open DevTools Console.
2. Paste all of `capture-kit.js`, hit Enter.
3. Press Play. A green `[loom-nflx] manifest captured` line + a track table appears.
4. `await __loomNflx.fetchSample('ja')` → downloads `netflix-ja.vtt`.
5. Save it over `sample-subs-ja.vtt` and re-run `parse-test.mjs`.

The kit also exposes `__loomNflx.dom()`, `.time()`, `.player()`, `.dumpTracks()`
to confirm the player-API path and overlay anchors on the live page.

## The real blocker to watch for

**Image-based subtitles.** Some CJK / Greek / Hebrew titles ship subtitles as
PNG bitmaps inside TTML v2 (no text) — exactly Loom's headline learner
languages. Detect by the **absence of `webvtt-lssdh-ios8`** in a track's
`ttDownloadables`; treat those as "no readable track" and degrade gracefully.
The capture kit warns when it sees such tracks.
