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
>
> **§1 (extension) IMPLEMENTED 2026-07-02** — `lib/corpus/{consent,capture}.ts`,
> capture wired into `discover.ts::resolveCaptions` (MT layers skipped),
> `entrypoints/onboarding/` + `runtime.onInstalled` hook, settings-panel
> "Data" section, `components/corpus-consent-prompt.tsx` re-ask, 17 vitest
> specs (`lib/corpus/corpus.test.ts`).  §1c corrected: the Firefox native
> optional-permission route is unavailable (websiteContent already
> `required`); the onboarding UI is the consent surface on both browsers.
> **Still owed:** live verification (§5), the §4 privacy/store copy edits,
> Railway/R2/secrets (§2–3), and the store release that ships all of it.

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

### 1c. Firefox native data-collection permission — NOT APPLICABLE (verified 2026-07-02)

The plan above originally routed Firefox consent through the manifest's
**optional** data-collection list + `permissions.request()`.  **That route
is structurally unavailable:** the manifest already declares
`data_collection_permissions.required: ["websiteContent"]` (wxt.config.ts —
transmitting subtitle text to the API for processing IS core functionality),
and Mozilla's framework is category-based — one category can't be both
required and optional.  Corpus *retention* is a purpose difference inside
the already-consented `websiteContent` category, which the framework can't
express separately.

Consequences:
- **The onboarding page + settings toggle are the consent surface on BOTH
  browsers** (implemented that way).  This exceeds Mozilla's baseline
  (category consent at install) and satisfies Chrome's affirmative-consent
  rule, so it's the review-safe posture everywhere.
- The AMO listing free-text + `/privacy` carry the retention disclosure
  (§4) — the category disclosure alone doesn't mention retention.
- Do NOT try to "fix" this by moving `websiteContent` to optional — core
  processing genuinely requires transmission; an optional grant would break
  romanize/annotate for anyone who declines.

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

**STATUS: VALIDATED LIVE 2026-07-05.**  First real export ran end-to-end from
a laptop against prod Postgres → Cloudflare R2: 6 partitions / 8,994 rows
(netflix en/ja/zh-Hant/zh-Hans + youtube zh/en), `corpus_export_manifest`
populated, all 20 source tracks stamped `archived_at`.  The monthly cron
(step 3 below) is the remaining piece — the manual path is proven.

### 3a. One-time infra (owner, Cloudflare + Railway)

1. **Create the bucket FIRST**, then the token — the token's bucket-scope
   dropdown only lists buckets that already exist.  Cloudflare R2 →
   Overview → Create bucket → `loom-corpus` (location: North America / auto;
   R2 has no egress fees so location barely matters for a monthly batch).
2. **Create an R2 *Account* API token** (not a user token — account tokens
   survive membership/role changes, correct for CI).  Manage R2 API Tokens →
   Create → **Object Read & Write** (NOT "Object Read only" — read-only gives
   `AccessDenied` on `PutObject`) → scope to `loom-corpus` → TTL Forever.
   Copy **both** the Access Key ID (32 hex) and Secret Access Key (64 hex)
   from the final screen via the copy buttons — the secret is shown ONCE.
   - **Do NOT save keys via "print to PDF"** — a monospace 64-char key runs
     off the page and silently truncates → `SignatureDoesNotMatch` (cost us
     ~30 min on 2026-07-05).  Verify length before use: fish
     `string length $AWS_SECRET_ACCESS_KEY` must print `64`.
3. **Endpoint** = `https://<account_id>.r2.cloudflarestorage.com`.  The
   account id is the path segment in any dashboard URL
   (`dash.cloudflare.com/<account_id>/…`), or shown on the R2 page.
4. **Railway DSN** = the Postgres service's **DATABASE_PUBLIC_URL** value (the
   internal `.railway.internal` URL is unreachable from CI / a laptop).

### 3b. Validate manually before trusting cron (the proven run)

Fish shell — note `set -x`, not bash `export`.  A fresh venv mirrors CI:

```fish
python3 -m venv /tmp/loom-export-venv
source /tmp/loom-export-venv/bin/activate.fish
pip install -r scripts/requirements-export.txt

set -x DATABASE_URL '<DATABASE_PUBLIC_URL value>'
set -x LOOM_CORPUS_BUCKET 'loom-corpus'
set -x LOOM_CORPUS_S3_ENDPOINT 'https://<account_id>.r2.cloudflarestorage.com'
set -x AWS_ACCESS_KEY_ID '<32-hex>'
set -x AWS_SECRET_ACCESS_KEY '<64-hex>'
set -x AWS_DEFAULT_REGION auto
set -x LOOM_ENRICH_AUTH_KEY '<a LOOM_BYPASS_KEYS value>'   # optional: skips rate limit on enrich

python scripts/export_corpus.py --settle-days 0 --dry-run   # walks, writes nothing
python scripts/export_corpus.py --settle-days 0 --enrich    # real: enrich → Parquet → R2
```

**`--settle-days 0` is only for same-day validation** — the default (7) skips
recently-captured rows so late captures settle; the cron keeps 7.  `--enrich`
replays caption text through the prod romanize/annotate batch endpoints to
populate the cache, then joins romanizations into the Parquet; idempotent
(cache hits free), so re-runs are fast.  Expect `wrote 6 partition file(s)`.
Verify: R2 objects under `corpus/platform=…/lang=…/captured=YYYY-MM/`,
`corpus_export_manifest` rows, and `archived_at` stamped on the tracks.

### 3c. Wire the monthly cron (the remaining piece)

**GitHub repo secrets** (Settings → Secrets → Actions) — same fresh keys:
- `CORPUS_DATABASE_URL` — the DATABASE_PUBLIC_URL.
- `CORPUS_BUCKET` — `loom-corpus`.
- `CORPUS_S3_ENDPOINT` — `https://<account_id>.r2.cloudflarestorage.com`.
- `CORPUS_AWS_ACCESS_KEY_ID` / `CORPUS_AWS_SECRET_ACCESS_KEY` — the R2 pair.
- `CORPUS_API_AUTH_KEY` — optional `LOOM_BYPASS_KEYS` entry for `--enrich`.

The workflow (`.github/workflows/export-corpus.yml`) **no-ops green until the
secrets exist**, then runs monthly (1st @ 06:17 UTC) with the safe 7-day
settle.  Confirm CI auth once via Actions → export-corpus → Run workflow,
`dry_run: true` (it'll export 0 until data ages past 7 days — expected).
Pruning is opt-in per run (`prune: true`); leave off until a Parquet's been
spot-checked (`duckdb -c "SELECT * FROM 'part-*.parquet' LIMIT 5"`).

**Security:** after keys are in GitHub secrets, delete any interim key copies
(desktop PDFs/screenshots) and any dead/rotated R2 tokens.  Secrets live in
GitHub (CI) + the ephemeral shell session only.

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

## 6. Multi-surface capture (IMPLEMENTED 2026-07-02 — web / desktop / player)

Decisions (Connor, 2026-07-02): web = visible checkbox **default ON**;
style fields **now**; desktop captures **via the prod API**, not direct DB.

- **Cache**: single `/romanize` + `/annotate` now share the batch
  endpoints' Layer-1 cache (the web app fans out singles and was bypassing
  it).  Web's `buildRomanizeMap` migrated to `/romanize/batch` (chunked at
  2000) — one request per episode instead of ~300.
- **Style capture** (the OCR `(text, style, language)` tuples):
  `corpus_line.style` + `corpus_track.styles_json`, additive/nullable
  (`ALTER TABLE ADD COLUMN IF NOT EXISTS` migrates an existing DB in
  place).  Style names participate in the content hash (a restyle = a new
  version); style definitions don't.  Exported as `style` +
  `track_styles_json` Parquet columns.  File sources capture ALL
  non-comment events INCLUDING signs/karaoke — stylized text is the hard
  OCR case — where the extension only ever sees plain dialogue.
- **Web** (`apps/web`): `lib/api/corpus.ts` fire-and-forget captures both
  parsed tracks after generation parse (platform `web`, media identity =
  upload filename stem + ffprobe container title, serialized SSAStyle
  map); "Contribute caption data" checkbox under Generate, default ON,
  per-run, with inline disclosure + /privacy link.  `/privacy` rewritten:
  Retention section now describes the real cache; new "Training corpus
  (opt-in)" section covers extension + web (the §4 copy for the store
  release can point at this page — it's live the moment Vercel deploys).
- **Desktop** (`apps/desktop` + sidecar): GenerateSection "Contribute
  caption data" checkbox (default ON — operator tool) → the EXISTING
  `opt_in_training` field on POST /generate/ass → the sidecar
  (`loom_api/corpus_forward.py`) re-parses both input files via the mtime
  cache and shapes `/corpus/capture` payloads (events + styles, native
  lang auto-detected, media identity = real filename stem since
  /files/by-path registers true paths).  **OFFLINE-FIRST (2026-07-02):**
  payloads are SPOOLED locally (`~/.loom/corpus-spool/`, one
  content-hash-named JSON per capture, atomic writes) and flushed to
  `LOOM_CORPUS_FORWARD_URL` (default = prod; `off` disables everything)
  at sidecar startup + after each generation — offline generation loses
  nothing; 2xx/dedup deletes the file, 4xx quarantines it as
  `.rejected.json`, network failure retries next flush.  No DB
  credentials on the desktop; one write path through one API.
- **Clients ship raw text only — the server owns ALL derived data.**
  Locally-computed romanizations never leave the desktop (cache-poisoning
  vector + engine-version skew).  Instead, `scripts/export_corpus.py
  --enrich` (now default in the monthly workflow; optional secret
  `CORPUS_API_AUTH_KEY` avoids rate limits) replays every unarchived
  corpus text through `/romanize/batch` + `/annotate/batch` before
  export — cache hits are free, so this is idempotent, and every exported
  Parquet row carries CURRENT-engine readings no matter which surface
  captured it or whether that surface was ever online.
- **Loom Player (design requirement, day one):** the player parses local
  `.mkv` subtitle tracks natively — richest source of all (full fansub
  ASS incl. typesetting).  Its design MUST include the same capture call
  (platform `player`, media identity = filename stem + container title,
  full styles) behind the same visible default-ON toggle, reusing the
  `/corpus/capture` contract unchanged.

## 7. Backlog (quality/durability, non-blocking — opened 2026-07-05)

Surfaced while validating the live corpus.  Neither blocks the pipeline;
capture is proven working on the extension (youtube + netflix) → Postgres →
R2.

1. **Extension capture has NO retry (durability hole).**  `lib/corpus/
   capture.ts` is fire-and-forget: a failed POST (server down / corpus
   disabled / network blip) is swallowed and that track's data is lost —
   no spool, no retry.  The *desktop* app already has store-and-forward
   (`corpus_forward.py` spool); the extension doesn't.  This is why the
   first Frieren episodes captured NOTHING: they were watched before the
   server's corpus store was enabled (`DATABASE_URL` unset → Null store →
   `{stored:false,"reason":"corpus disabled"}`), and fire-and-forget never
   retried.  Fix: a small `storage.local` retry queue (mirror the desktop
   spool), or at minimum surface persistent failures.  For a data-
   collection feature this is a real gap — do it when next hardening corpus.

2. **Netflix `title` capture is cosmetic-broken.**  Rows land with
   `title = "Netflix"` instead of the show name, because capture reads
   `document.title`, which on a Netflix watch page is often the literal
   string "Netflix" (show name never reaches the tab title, or lands after
   the one-shot capture fires).  IDENTITY is unaffected — `platform` +
   `platform_media_id` (movieId) is correct, and `title` is display-only,
   COALESCE'd, never used for joins.  So no data is corrupted; the label is
   just useless.  Fix: read the title from a reliable source (the manifest,
   or a DOM selector like `[data-uia="video-title"]`) instead of
   `document.title`.  Won't retroactively fix stored rows, but movieId→title
   is externally recoverable.  YouTube is unaffected (its `document.title`
   IS the video name).
