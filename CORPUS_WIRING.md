# Corpus Layer 2 — Wiring Plan

> **Status:** server infrastructure SHIPPED 2026-07-02 (`POST /corpus/capture`
> + `corpus_store.py` + `corpus_export.py` + `scripts/export_corpus.py` +
> `.github/workflows/export-corpus.yml`; `@loom/api-client` regenerated with
> the new endpoint).  This doc is the plan for everything that CONNECTS to it:
> the extension capture call + opt-in toggle, the Railway/R2/GitHub secrets,
> and the privacy/store copy.  Design rationale lives in
> `ROMANIZATION_CACHE.md`; schema in `loom_api/corpus_store.py`'s docstring.

The server side is deliberately inert until wired: with no `DATABASE_URL`
the store is a Null no-op; even with a DB, nothing is stored unless a
request arrives with `opt_in_training: true` — which only the extension
toggle (below) ever sets.

---

## 1. Extension wiring (the `opt_in_training` wire-up owed since 5f)

### 1a. Setting + storage

- New storage key, following the `loom_` convention:
  `const STORAGE_KEY_CORPUS_OPT_IN = "loom_corpus_opt_in";` — default **false**.
- Module-level state in `lib/captions/discover.ts` alongside the existing
  annotation prefs (`STORAGE_KEY_TARGET_ANNOTATE_ENABLED` block, ~lines 60–82);
  load it in `loadAnnotationPrefs()`; add a `setCorpusOptIn()` setter that
  persists + updates the module var (pattern: `setTargetAnnotateEnabled`,
  ~lines 970–1008).
- Expose through `CaptionContextValue` in `components/caption-context.tsx`
  (same shape as the other boolean settings there).

### 1b. Settings-panel toggle

- `components/settings-panel.tsx`: new collapsible `<Section>` just above the
  "Turn off Loom on this tab" footer (~line 722), hooked into the collapsible
  state via `{...section("data-collection")}`.
- One `ToggleRow` (existing component, see usages ~lines 534/582):
  - Label: **"Contribute caption data"**
  - Hint text: *"Send the subtitles of videos you watch (video title/ID and
    caption text — never anything about you) to Loom's training corpus to
    improve annotations, romanization, and future OCR support. Off by
    default."*

### 1c. The capture call

- New module `lib/corpus/capture.ts`:
  - Builds the payload from data already in scope in
    `lib/captions/discover.ts::resolveCaptions()` (~lines 418–576) after
    `fetchWithCache()` resolves a track's events:
    - `lines`: map `CaptionEvent[]` (`{start, end, text}`, **already in ms**
      — `lib/captions/types.ts:53`) → `{seq: i, start_ms, end_ms, text}`.
    - `platform`: from the active `CaptionPlatform` impl.
    - `media_id`: `session.videoId` (YT videoId / NF movieId).  **iQIYI/WeTV
      gap:** neither extracts a media id today — derive from
      `location.pathname` (iq.com `/play/<slug>`, wetv `/play/<cid>/<vid>`)
      or send the pathname itself; do NOT block capture on prettiness.
    - `title`: not currently available on any platform (YT/NF manifests
      don't carry it) — send `null` now; a best-effort `document.title`
      scrape (strip " - YouTube" etc.) is an acceptable later polish.
    - `track_id` / `track_lang` / `is_cc` / `track_kind`: straight off
      `CaptionTrack` (`id`, `languageCode`, `isCc`, `kind`).
    - `origin_lang`: `CaptionTrack.audioLangCode` when present (Netflix).
    - `opt_in_training: true` (the call is only made when the toggle is on).
  - Calls `getApiClient().POST("/corpus/capture", {body})` — the endpoint is
    in the regenerated `@loom/api-client` types already.
  - **Fire-and-forget with a swallow-everything catch** (same posture as the
    annotate/romanize fetches): capture must never affect the overlay.  The
    server is idempotent (content-hash dedup), but keep a session-level
    `Set<string>` of `videoId::trackId` already sent to avoid re-POSTing on
    every re-activation/track flip.
- Call site: in `resolveCaptions()` right where `targetEvents` /
  `nativeEvents` land (the same spot that triggers the annotation fan-out).
  **Capture both target and native tracks** — the native side is training
  data too (styled Latin/native text for OCR) and it's the same one-liner.
- Also flip the already-plumbed-but-unused `optInTraining` option to the
  batch calls (`BuildAnnotateMapOptions.optInTraining` /
  `BuildRomanizeMapOptions.optInTraining`, `lib/{annotate,romanize}/build-map.ts`)
  so the request-level flag finally reflects reality.  Server-side it's
  currently informational on those routes; capture happens via /corpus/capture.

### 1d. Tests + release

- vitest: payload-builder unit tests (event→line mapping, empty-text
  passthrough — server drops them, client shouldn't bother filtering beyond
  what it does today; sent-set dedup logic).
- Ships in the next store release (0.3.1/0.4.0) **together with the privacy
  copy below** — do not ship the toggle without the copy.

## 2. Railway (shares Layer 1's wiring — nothing extra)

The corpus store uses the same DSN as the result cache (`LOOM_CORPUS_URL`
overrides, else `DATABASE_URL`).  If the Layer-1 checklist is done (Postgres
service + `DATABASE_URL` reference var on the API service), Layer 2 tables
create themselves at the next worker boot.  Kill switch: `LOOM_CORPUS=off`
(independent of the cache's `LOOM_RESULT_CACHE=off`).

## 3. Object storage + scheduled export

1. **Create the bucket.**  Recommended: Cloudflare R2 (`loom-corpus`) — zero
   egress for training reads, S3-compatible.  Create an R2 API token scoped
   to that bucket (Object Read & Write).
2. **GitHub repo secrets** (Settings → Secrets → Actions):
   - `CORPUS_DATABASE_URL` — Railway Postgres **DATABASE_PUBLIC_URL** (the
     internal `.railway.internal` URL is unreachable from CI).
   - `CORPUS_BUCKET` — bucket name.
   - `CORPUS_S3_ENDPOINT` — `https://<account_id>.r2.cloudflarestorage.com`
     (omit for AWS S3).
   - `CORPUS_AWS_ACCESS_KEY_ID` / `CORPUS_AWS_SECRET_ACCESS_KEY` — the R2
     token pair (or AWS IAM keys).
3. The workflow (`.github/workflows/export-corpus.yml`) runs monthly and
   **no-ops green until the secrets exist**.  First real run: trigger
   manually (Actions → export-corpus → Run workflow, `dry_run: true` first).
   Pruning is opt-in per run (`prune: true`) — leave it off until bucket
   contents have been spot-checked once (open a Parquet in
   pandas/DuckDB: `duckdb -c "SELECT * FROM 'part-*.parquet' LIMIT 5"`).

## 4. Privacy / store copy (ship WITH the extension toggle)

- **`/privacy` (apps/web)** — add a section:
  > **Training corpus (opt-in).**  If you enable "Contribute caption data"
  > in Loom's settings, Loom stores the subtitle text of videos you watch,
  > together with the video's platform, ID/title, and the captions' timing,
  > in an aggregate corpus used to improve Loom's annotations, romanization,
  > and OCR research.  This data is stored WITHOUT any account, IP address,
  > device, or user identifier — it describes media content, not you, and
  > identical content is stored only once regardless of how many people
  > watch it.  The setting is off by default.  Turning it off stops all
  > future contribution immediately.
- **AMO / Chrome listing** — the existing `data_collection: websiteContent`
  declaration already covers transmission; extend the free-text data-use
  notes to mention the opt-in retention in one sentence mirroring the above.
- **Reviewer notes** (next `SUBMISSION_*.md`): call out that the toggle is
  opt-in, default-off, and that the payload contains no user identifiers.

## 5. Verification checklist (after wiring)

1. Railway logs: `loom.corpus` line `capture platform=… lines=N` on first
   opted-in activation; re-activating the same episode → response
   `deduped: true`, no new line.
2. Postgres data tab: `corpus_media` / `corpus_track` / `corpus_line`
   populated; line texts are NFC-normalized (join-compatible with
   `romanization_cache.input_text`).
3. Manual `workflow_dispatch` with `dry_run: true` → log shows the would-be
   partitions.  Real run → Parquet in the bucket + a
   `corpus_export_manifest` row + `archived_at` stamped.
4. Open the Parquet: each row self-contained (media + timing + text +
   `romanizations_json`/`annotations_json` populated for lines the cache
   has seen).
5. **Owed live verification (same posture as Layer 1):** the Postgres
   store + export SQL have unit-tested semantics (InMemory parity + pure
   record shaping) but the SQL itself first executes for real on Railway —
   treat step 1–4 as the acceptance test.
