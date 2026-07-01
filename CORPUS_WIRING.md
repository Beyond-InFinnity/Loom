# Corpus Layer 2 — Wiring Plan

> **Status:** server infrastructure SHIPPED 2026-07-02 (`POST /corpus/capture`
> + `corpus_store.py` + `corpus_export.py` + `scripts/export_corpus.py` +
> `.github/workflows/export-corpus.yml`; `@loom/api-client` regenerated with
> the new endpoint).  This doc is the plan for everything that CONNECTS to it:
> the extension consent flow + capture call, the Railway/R2/GitHub secrets,
> and the privacy/store copy.  Design rationale lives in
> `ROMANIZATION_CACHE.md`; schema in `loom_api/corpus_store.py`'s docstring.
> **Consent design revised 2026-07-02:** two-touch active ask (install-time
> onboarding + one post-first-episode re-ask) instead of a buried settings
> toggle — see §1a; store-policy sources in the section.  Dev/owner builds
> capture by default.

The server side is deliberately inert until wired: with no `DATABASE_URL`
the store is a Null no-op; even with a DB, nothing is stored unless a
request arrives with `opt_in_training: true` — which only the extension
toggle (below) ever sets.

---

## 1. Extension wiring (the `opt_in_training` wire-up owed since 5f)

### 1a. Consent model (REVISED 2026-07-02 — replaces the settings-toggle-only design)

A buried default-off toggle converts at ~zero, defeating the corpus.  Both
stores forbid pre-consented collection (Chrome: "prominent disclosure +
affirmative consent" via a specific agreeing action, and NOT only in a
privacy policy/settings page; Mozilla: opt-in via the data-collection-
permissions framework).  The compliant maximum-conversion design is a
**two-touch active ask**:

1. **Install-time ask.**  `runtime.onInstalled` (reason `"install"` ONLY —
   never on `"update"`) opens an onboarding page (1b) ending in the choice:
   large primary **"Contribute caption data"** button, quieter "No thanks".
   Clicking primary = the affirmative action both stores require.  A
   pre-checked box + Continue does NOT qualify — don't build that.
2. **One deferred re-ask** for users who closed the tab without choosing:
   after Loom's first successful episode render (peak goodwill), show the
   same choice once in-overlay.  Never ask again after an answer or after
   the re-ask; the settings toggle (1e) is the permanent control.
3. **Dev/owner builds capture by default** (gate on `IS_DEV`, like the
   owner-key field) — no prompt; Connor's own watching builds the corpus
   from day one regardless of public adoption.  Content dedups, so heavy
   watchers are the corpus's anchor tenants.

State is a **tri-state**: `loom_corpus_opt_in` ∈ unset / `true` / `false`,
plus `loom_corpus_asked` (bool) so the re-ask fires at most once.  Unset
behaves as `false` for capture.

Policy sources (verified 2026-07-02): Chrome [disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements)
+ [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
(consent must be a specific agreeing action, before collection, not only in
a privacy policy); Mozilla [built-in data-collection consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
+ [Oct 2025 rollout](https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/)
(mandatory for new extensions from 2025-11-03; optional-list data consented
via `permissions.request()`).

### 1b. Onboarding page (doubles as the parked first-run explainer)

- New WXT HTML page entrypoint (e.g. `entrypoints/onboarding/`), opened by
  the background script on install.  This is ALSO the "What is Loom?"
  first-run explainer parked in `UI_REVISIONS.md` — 30 seconds of "click the
  pill on a video / here's the 4-layer stack", ending in the contribute ask
  so the consent reads as the last step of setup, not a data grab.
- Ask copy: *"Help improve furigana, romanization, and future OCR for
  everyone — contribute anonymous caption data.  This shares what you watch
  (video ID + subtitle text), never anything about you."*  Buttons:
  **Contribute caption data** (primary) / No thanks (secondary).

### 1c. Firefox: route consent through the native data-collection permission

- Declare the collection in the manifest's **optional** data-collection list
  (`browser_specific_settings.gecko.data_collection_permissions.optional`,
  Firefox-manifest branch of `wxt.config.ts`) — it then appears natively in
  the install flow's data disclosure and as a toggle in `about:addons` →
  Permissions and Data.
- The onboarding page's primary button calls `browser.permissions.request()`
  for that data permission (needs a user gesture — the click is one), so the
  yes lands in Mozilla's own consent UI: maximally review-proof.  Keep
  `loom_corpus_opt_in` as the source of truth and listen to
  `permissions.onAdded/onRemoved` so the native about:addons toggle and the
  panel toggle stay in sync.
- Graceful degradation: if the data-collection `permissions.request()` shape
  isn't supported by the running Firefox version, fall back to writing the
  setting directly (Chrome's only path anyway).
- Do NOT put it in the `required` list — that gates every install behind a
  mandatory "collects website content" disclosure (repels the 100% of users
  who just want subtitles) and is exactly the ancillary-data-as-required
  pattern reviewers reject.

### 1d. Setting + storage

- Storage keys, following the `loom_` convention:
  `loom_corpus_opt_in` (tri-state, absent = unset) + `loom_corpus_asked`.
- Module-level state in `lib/captions/discover.ts` alongside the existing
  annotation prefs (`STORAGE_KEY_TARGET_ANNOTATE_ENABLED` block, ~lines 60–82);
  load in `loadAnnotationPrefs()`; add a `setCorpusOptIn()` setter that
  persists + updates the module var (pattern: `setTargetAnnotateEnabled`,
  ~lines 970–1008).  In dev builds, treat unset as **true** (1a.3).
- Expose value + setter through `CaptionContextValue` in
  `components/caption-context.tsx` (same shape as the other boolean settings).

### 1e. Settings-panel toggle (the persistent control)

- `components/settings-panel.tsx`: new collapsible `<Section>` just above the
  "Turn off Loom on this tab" footer (~line 722), hooked into the collapsible
  state via `{...section("data-collection")}`.
- One `ToggleRow` (existing component, see usages ~lines 534/582):
  - Label: **"Contribute caption data"**
  - Hint text: *"Send the subtitles of videos you watch (video title/ID and
    caption text — never anything about you) to Loom's training corpus to
    improve annotations, romanization, and future OCR support."*
- On Firefox, flipping this toggle should request/remove the native data
  permission (1c) so `about:addons` reflects reality.

### 1f. The capture call

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
    - `opt_in_training: true` (the call is only made when consent state
      resolves true — 1a/1d).
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

### 1g. Tests + release

- vitest: payload-builder unit tests (event→line mapping, sent-set dedup)
  + consent-state resolution (unset/true/false × dev/prod, re-ask fires at
  most once).
- Ships in the next store release (0.3.1/0.4.0) **together with the privacy
  copy below** — do not ship the consent flow without the copy.
- Reviewer notes must volunteer the flow: optional collection, requested via
  prominent onboarding consent (native data-collection permission on
  Firefox), nothing stored before affirmative action, revocable in settings,
  no user identifiers in the payload.

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

0. Consent flow: fresh install opens onboarding once (never on update);
   "No thanks" / dismiss → no capture calls at all; dismiss → re-ask
   appears exactly once after the first rendered episode; Firefox
   `about:addons` Permissions-and-Data toggle stays in sync with the
   panel toggle both directions.
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
