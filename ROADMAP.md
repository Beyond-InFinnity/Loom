# Loom — Roadmap & Deferred Work

Forward-looking plans split out of `CLAUDE.md` to keep the session-loaded briefing lean. Shipped-work history lives in the dated archives at `general_project_notes/notes/srtstitcher/CLAUDE*_ARCHIVE.md`; this file holds only what hasn't shipped yet (plus a couple of durable architecture-verdict references pointed to from `CLAUDE.md`).

**Active recon:** `NETFLIX_RECON.md` — investigating a port of the dual-subs overlay from YouTube to Netflix.  Started 2026-05-28; aims for go/no-go after a 2–3 day spike.  About 60% of the existing extension code is platform-agnostic, so the marginal cost of adding Netflix is bounded.  See that doc for the recon checklist + decision framework.

**Active publishing plan:** `PUBLISH_PLAN.md` — getting the YouTube extension installable by friends/family as a "proper" extension (Firefox AMO + Chrome Web Store), not "load this temp add-on from a folder."  Started 2026-05-29.  Covers the dev/prod build split (~1 day of work, technical foundation), the non-code store-prep checklist (privacy policy, permission justifications, screenshots, icons), and the phased rollout (Firefox AMO self-distribution first → closed beta → Chrome Web Store unlisted → public listings).  See that doc for the per-step checklist and draft privacy-policy text.

---

## Roadmap Beyond Step 4

**Purpose:** capture every forward-looking item that surfaced during step-4 build-out but didn't ship in v1.  Three buckets — v1.5 follow-ups (the immediate next deltas after the public deploy), v2 (UX expansion that requires real design work), and long-term (deeper architectural moves that wait for a real signal).  Each item lists a trigger ("ship when") so future sessions don't relitigate scope.

### v1.5 — Closing the gaps the survey exposed

These are the items that v1's "skinny scope" intentionally left for the first iteration after deploy.  None block production today, but each is on the critical path to a polished tool.

**1. PGS rendering of preserved events.**  Currently `iterPreservedEvents()` in `apps/web/lib/subs/style-classify.ts` yields signs / karaoke / typesetting events from multi-style fansub tracks.  `generate-ass.ts` copies those events through to the `.ass` output with original styling intact, but the rasterizer (`apps/web/lib/raster/timeline.ts::buildPgsTimeline`) filters them out — so they appear in mpv from the `.ass` track but are missing from the `.sup` bitmap track.
- **Port `_dedup_preserved_for_pgs`** from `loom_core/subs/processing.py` (lines 453-555) — handles overlapping karaoke compositing layers.  Critical because raw karaoke layers (sweep + shadow + base) all render simultaneously when animation tags are stripped.
- **Wire `stripAnimationTags()`** (already in `style-classify.ts`) into a separate raster pass.  Render preserved events with motion tags removed; visual-styling tags (font / color / pos / outline / shadow) preserved.
- **Add second timeline pass** for preserved events.  Lives alongside the dialogue timeline; raster output composites both into one `.sup`.
- **Ship when:** any production user complains that signs/karaoke don't appear in the muxed output, or before the first 3rd-party demo.  Estimated ~300 LOC.

**2. `/annotate` API client wiring.**  The endpoint exists and works (verified live: `/annotate ja` returns furigana ruby HTML; `/annotate zh-Hant` returns per-character Zhuyin).  No client consumer.  Required for furigana in the `.sup` rasterizer — currently `build-html.ts` renders plain target text, so the bitmap output has no per-character readings.  ASS path uses `\pos()` annotation but only for CJK (the `supports_ass_annotation` gate); non-CJK languages need PGS-rendered annotation.
- **Add `buildAnnotateMap()`** in `apps/web/lib/api/`, parallel to `buildRomanizeMap()`.  Same fan-out + memo pattern.
- **Update `build-html.ts`** to accept an optional `annotation_html` parameter and inject it as a third `.layer` div above the Top layer.
- **Ship when:** v1.5 PGS preserved-event work lands (same code path).  Estimated ~150 LOC.

**3. Concurrent dialogue event merging.**  Python's `_merge_concurrent_target_events()` handles dual-speaker overlapping lines (one character speaking while another's line still on screen).  Web port currently does first-overlap match — picks one, drops the other.  Rare in practice for single-speaker anime but common in dramas / multi-character ensemble work.
- **Port `_merge_concurrent_target_events`** from `loom_core/subs/processing.py`.  Music-only event filtering (`_is_music_only`) already in scope of the port.
- **Ship when:** anyone reports dialogue dropouts during ensemble scenes.  Estimated ~100 LOC.

**4. SRT crawl-bait + episode-card skip heuristic.**  Survey caught spam in multiple SRTs: `"For best IPTV provider..."` (DW3 across 5 languages), `"Created and Encoded by Bokutox"` (Gran Torino YIFY), `"=Three-Body=" / "=Episode 1="` (Tencent Three Body title cards).  These get fanned to `/romanize` as dialogue and pollute the Romanized layer.
- **Heuristic regex skip** for events matching `/(www\.|provider|encoded by|^=.+=$|^\[.+\]$)/i` BEFORE the unique-text collection in `buildRomanizeMap`.
- **Estimated:** ~10 LOC.  Could ship as a dedicated 4f-followup commit any time.

**5. Speaker-tag stripping toggle.**  Japanese SRTs commonly prepend speaker names: `（アルミン）...`, `(花澤香菜)...`.  Currently the speaker tag survives romanization (`(Arumin)yatsura ni shihai...`).  Generally desirable for following dialogue, but some users may want it stripped.
- **Add `strip_speaker_tags: bool` to `StyleConfig`** (off by default).
- **Pre-process target text** in `generateAssFile` and `buildRomanizeMap` to strip leading `(...)` / `（...）` when toggle is on.
- **Ship when:** UI editor lands (v2) — meaningless without a UI control.  Estimated ~30 LOC.

**6. HI-track auto-detection warning.**  Squid Game's HI Korean track has bracket-tagged sound descriptions (`[흥미로운 음악]`, `[Music]`) interspersed with dialogue.  These count as dialogue events and produce technically-correct-but-noisy romaji.
- **Heuristic:** if a track has >20% events matching `/^\[.+\]$/`, surface a warning in the track picker UI: "This looks like a hearing-impaired track — sound descriptions will be romanized too.  Pick the non-HI track for cleaner output."
- **Estimated:** ~50 LOC including UI.  Polish-tier; defer until UI editor.

### v2 — Style editor + live preview

The big v1-deferred bucket.  v1 ships defaults-only generation (`defaultStyleConfig()`); v2 brings the full UI parity with the desktop app's style controls.  All of this is "additional UX surface" rather than new pipeline work — the engine already supports everything below.

**Per-layer style editor** matching the desktop's Section components in `apps/desktop/src/sections/`:
- Color + opacity per layer (Bottom, Top, Romanized, Annotation)
- Font family + size per layer (with the FontScanner's missing-glyph warning wired)
- Outline (toggle + thickness + color + opacity)
- Shadow (toggle + distance)
- Glow (toggle + radius + color, emits `\blur`)
- Top stack position (vertical offset, annotation/romanized gaps)

**Color presets** — 28 presets across classic / cultural / dark / adaptive groups, language-scoped.  Already in `loom_core/color_presets.py`; need API endpoint exposure + UI dropdown.

**Output resolution scaling** — 480p / 720p / 1080p / 1440p / 2160p / Match source.  Server side already handles `_PLAYRES_OPTIONS` + `_scale = target_height / 1080`; client needs a selector.

**Timing offsets** — manual per-track ms shift via `shift_events()`; auto-alignment via `compute_subtitle_offset()`.  Both already in `loom_core/subs/utils.py`.  Needs UI sliders + an "Auto-align" button that fires the histogram pass.

**Live preview pane** — single-frame composite preview at a chosen timestamp.  Backend already has `POST /preview` (`loom_api/routes/preview.py`); web frontend skips it in v1.  Wire it up alongside the style editor so users see changes in real time without running a full generate.

**Ship when:** real users start using the v1 default-styles output and ask for customization.  Until then, "use the desktop app for fine control" is an acceptable answer per memory `project_pgs_web_priority.md`.

### Long-term — Architectural moves

**Web Worker for rasterization.**  Currently `rasterizeFrames()` runs on the main thread; html2canvas + canvas processing block UI for ~1437 frames on a Frieren episode.  We mitigated with `setTimeout(0)` yields in commit `e6f2be7`, but a real fix is moving the whole pipeline into a Web Worker so the main thread stays responsive.  Cost: html2canvas's DOM walker needs the live document, which workers don't have — would need a different rendering path entirely.  Probably the same code shift as the next item.

**Canvas2D direct draw bypassing html2canvas.**  The 4b spike validated html2canvas as the architectural choice — but at the cost of ~0.6% pixel divergence vs native Chromium.  A direct Canvas2D drawer (taking ASS-style text + position math + outline/glow shaders) would be byte-identical and could run in a Web Worker.  Cost: substantial — would reimplement layered text positioning, outline emulation, ruby layout.  ~1500 LOC minimum.  Memory `project_pgs_web_priority.md` documents the tradeoff: this ships only when a user genuinely needs byte-perfect web PGS output AND can't fall back to the desktop bundle.

**Hardening / observability before public announcement.**
- **Cloudflare in front of Railway** — free-tier WAF + bot detection.  Catches the abuse modes that get past slowapi (rotating IP scraping, especially).  Easy add: change `LOOM_CORS_ORIGINS` + Cloudflare DNS proxy toggle + verify Tier-B Cloudflare Access compatibility.
- **Sentry (or similar) error tracking** — currently `/generate` failures only surface in the user's browser; we have no aggregated view of production errors.  Add `@sentry/nextjs` to the web app + `sentry-sdk` to the API.
- **Analytics** — Plausible (privacy-respecting, $9/mo) or Vercel Analytics (free tier).  Tracks `/generate` start/complete rates, language breakdowns, file-size distributions.  Useful signal for prioritizing v1.5 work.
- **Multi-region Railway** — only relevant if traffic outside the US/EU starts mattering.  Not on the radar yet.

**Ship when:** before the first non-Connor-only public link; or when an outage happens and we realize we can't see it.

### Closing 4f / 4g

**4f production verification (owed).**  We pushed all the deploy fixes (`1af8a9d`, `e6f2be7`, `e340380`, `96e6148`) but the post-fix end-to-end test still owed: drop an AoT episode at the live `loom.nerv-analytic.ai/generate`, watch a successful complete generation, confirm `.ass` + `.sup` download, mux back into source, play in mpv, verify subs render.  This is the canonical "deploy actually works" gate.  Once this passes once, 4f is closed.

**4g Streamlit deletion (not started).**
- Delete `loom_app.py` + `app/` directory entirely.
- Update `CLAUDE.md` Project Structure section to drop the Streamlit references.
- Update Capability Matrix to drop the Streamlit column (it's currently absent — already done).
- Drop `streamlit`, `pandas`, `pyarrow`, `pydeck`, `altair` from `requirements.txt` (the desktop venv).
- Verify `apps/desktop` still works without those (uvicorn sidecar shouldn't need any of them).
- **Ship when:** 4f production verification passes.  Once the web app is reachable + working, the Streamlit prototype's job is done.

---

## Owner Auth — Tiers B & C

### Tier B — Google OAuth identity binding (planned, post-Step 5)

**Trigger:** when the synthetic-data pipeline (Step 6) starts attributing training samples to specific operator emails — e.g., for cleaner provenance in training-set documentation, or if Connor wants per-email rate budgets ("I'm OK with anyone reading 100k samples/day from `connor.m.finnerty@nerv-analytic.ai` but only 1k/day from secondary accounts").

**Design:**
- "Sign in with Google" button in `apps/web/app/owner/page.tsx`.
- Frontend uses `@react-oauth/google` to obtain a Google ID token (JWT).
- ID token sent to a new `POST /auth/session` endpoint on `loom_api.web`.
- Backend verifies the JWT signature against Google's public keys + checks `email_verified=true` + checks `email` claim against `LOOM_OWNER_EMAILS` env-var allow-list (`infinnity12@gmail.com,connor.m.finnerty@gmail.com,connor.m.finnerty@nerv-analytic.ai`).
- On success, backend mints a short-lived session token (HS256-signed JWT, 24h TTL).
- Frontend stores session token in `localStorage` (replaces `loom_owner_key`).
- `BypassAwareSlowAPI` updated: accept either `X-Loom-Auth: <bypass-key>` (Tier A) OR `X-Loom-Auth: Bearer <session-jwt>` (Tier B). The internal predicate becomes "is this request authenticated as the operator?" — same bypass behavior, broader auth backends.
- Token refresh on 401: frontend silently retries Google sign-in.

**Migration from A:** strictly additive. Tier A keys keep working forever; Tier B adds a second authentication backend. No frontend rewrite — `X-Loom-Auth` header path stays unchanged, just carries a different secret format.

**Cost:** ~2-3 hours setup (Google Cloud OAuth client + redirect URIs for prod custom domain + Vercel preview wildcards), two new deps (`google-auth` server-side, `@react-oauth/google` client-side), one new endpoint, +~100 lines.

### Tier C — Cloudflare Access network gate (deferred indefinitely)

**Trigger:** if Tier B's email-binding still isn't enough — e.g., we want zero-trust gating with device posture checks, or want to put `loom.nerv-analytic.ai` itself behind auth (not just the API).

**Design:**
- Cloudflare in front of both `api.loom.nerv-analytic.ai` and `loom.nerv-analytic.ai`.
- Cloudflare Access policy: `email in {infinnity12@gmail.com, ...}`.
- Visitors hit the Cloudflare-issued login page (Google/email magic-link), get a Cloudflare Access JWT cookie, then their request reaches Railway/Vercel.
- Backend optionally re-validates the `CF-Access-Jwt-Assertion` header for defense-in-depth.

**Why deferred:** putting the public site itself behind auth defeats the purpose (it's a tool for general use; only the bypass path is auth-gated). Could selectively gate `/api/*` paths if we proxy through Cloudflare Workers, but that's complexity for what Tier B already handles.

**Cost:** ~30 min setup, free tier covers it, but the routing complexity (which paths gated, which not) doesn't pay for itself unless Tier B is also somehow inadequate.

### Implications for the synthetic data pipeline (Step 6)

The OCR closed-loop pipeline runs as a batch process — it'll generate millions of `(rendered_image, text, language, style)` tuples by:
1. Sampling text from the extension's archived corpus (`opt_in_training=true` path),
2. Calling `/romanize` + `/annotate` to enrich each sample with phonetic + annotation ground-truth,
3. Rendering through the same html2canvas / Playwright pipeline used in production,
4. Feeding the resulting bitmap + text pairs to TrOCR fine-tuning.

Steps 2–3 will hit the slim API hard (one call per sample, potentially fan-out for varied phonetic systems). Tier A's bypass key is the v1 enabler — without it the pipeline would either rate-limit itself to a crawl or need a separate "internal" deployment path. With Tier A, the pipeline runs from Connor's laptop / a CI runner with `X-Loom-Auth` set and slowapi never sees it.

Tier B becomes relevant if we want to attribute generated samples to specific operator identities for dataset documentation (e.g., "this 50k-sample subset was assembled by `connor.m.finnerty@nerv-analytic.ai` on 2026-09-15"). Not strictly required for the pipeline to function.

---

## Reference: PGS-in-browser spike verdict

**Spike: PGS-in-browser (4b verdict, 2026-05-03):** `spike/pgs-browser/` validates that the browser can capture rendered subtitle pixels for PGS encoding. **Direct path is blocked by canvas-tainting:** drawing an SVG `<foreignObject>` (which would have been the pixel-perfect approach) to canvas marks it origin-opaque, so `getImageData` throws. Workaround that survived the spike: **html2canvas** library (~200KB) walks the DOM and draws text/shapes via Canvas2D primitives — no SVG, no taint. Both phases (Latin+Japanese, then Hebrew RTL + ruby furigana + Japanese) showed ~0.6% pixel divergence vs the desktop's Playwright reference, with the diff concentrated as 1–2px sub-pixel offsets at glyph edges (html2canvas's text-layout heuristics differ slightly from native Chromium's). **The "byte-identical SUP file" goal is not achievable with this approach** — the web app's PGS bytes will differ from the desktop's. **Visual equivalence is achievable** — both render the same content, same fonts, same positioning at viewer-perceptible scale. Step 4d (JS port of `sup_writer`) needs to operate on whatever pixels html2canvas produces, not match a reference byte-stream. Spike artifacts kept under `spike/pgs-browser/` for re-running on Chromium upgrades; raw `.bin` buffers + per-run `stats.txt` are gitignored, but `reference.png`, `browser.png`, `diff.png` are committed as evidence.
