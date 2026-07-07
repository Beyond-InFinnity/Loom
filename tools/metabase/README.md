# Metabase — human-friendly corpus browser

Spreadsheet-style browsing of the Loom training corpus (the Railway
Postgres that `/corpus/capture` writes to and the R2 Parquet export reads
from), with zero SQL required once set up. Point-and-click filter / sort /
group, saved views, charts, and multi-user access for demos.

**Why this covers R2 too:** the monthly export *copies* rows to R2 — it
never deletes from Postgres (`--prune` is manual-only and has never been
run). `setup.sql` additionally creates **`corpus_export_view`**, a live
view with column-for-column parity to the Parquet files (the same
romanization-cache join `corpus_export.py` performs at export time). So
"what does the R2 data look like?" is answered by browsing that view —
no tool needs to read Parquet off R2. Spot-checking the *actual files*
stays a `scripts/inspect_corpus.py` / DuckDB job.

## One-time setup

### 0. Docker group (once per machine)

The daemon runs but `connor` isn't in the `docker` group:

```bash
sudo usermod -aG docker connor
```

Then log out/in (or run the compose commands below prefixed with
`sg docker -c '...'` to pick up the group without re-login).

### 1. Prepare the Railway DB (read-only role + views)

Grab the **public** connection string from Railway → Postgres service →
Variables → `DATABASE_PUBLIC_URL` (the `.railway.internal` one is
unreachable from outside Railway). Then, from the repo root:

```bash
export DATABASE_PUBLIC_URL='postgresql://postgres:...@...proxy.rlwy.net:PORT/railway'
docker run --rm -i postgres:16-alpine \
  psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 \
  -v ro_password=CHOOSE_A_PASSWORD < tools/metabase/setup.sql
# note: no quotes around the password value — the script quotes it itself

```

Idempotent — re-run any time (e.g. after schema changes) to refresh the
views. It creates:

| Object | What it is |
|---|---|
| `metabase_ro` role | SELECT-only login Metabase uses — it can never write to the corpus |
| `corpus_browse` view | **The Excel sheet.** One row per subtitle line: platform, title, language, `HH:MM:SS` timestamps, text, its romanization as plain text |
| `corpus_export_view` view | Exact R2 Parquet schema (18 columns incl. the JSON romanization/annotation maps), computed live |
| `corpus_stats` view | Platform × language rollup (media / tracks / lines, capture window, tracks already in R2) — dashboard fodder |
| index on `romanization_cache` | Keeps the view joins fast as the cache grows |

### 2. Start Metabase

```bash
cd tools/metabase
docker compose up -d        # first boot pulls images + initializes, ~1-2 min
```

Open <http://localhost:3000>, create the admin account. When it asks to
add a database (or later via **Admin → Databases → Add**):

- Type: **PostgreSQL**
- Name: `Loom corpus`
- Host / Port / Database: from `DATABASE_PUBLIC_URL` (host like
  `xxxx.proxy.rlwy.net`, its port, database `railway`)
- Username: `metabase_ro`, Password: the one you chose in step 1
- SSL: on (Railway requires it)

## Using it

- **Browse databases → Loom corpus → Corpus Browse** — the main grid.
  Click any column header to filter/sort; click **Filter** for
  point-and-click predicates (platform = netflix, track_lang = ja, text
  contains …); **Summarize** for instant counts/grouping. Save useful
  configurations as named questions.
- **Corpus Export View** — show someone "this is exactly what lands in
  the R2 Parquet."
- **Corpus Stats** — one-glance corpus size; turn it into a bar chart
  (lines by language, colored by platform) in two clicks and pin it to a
  dashboard.
- Under Admin → Table Metadata you can hide the raw `corpus_*` tables
  and `romanization_cache` if you want demos to see only the curated
  views.

### Demoing to others

- Same room / screen-share: just drive `localhost:3000`.
- Send-a-link **public sharing** (Admin → Settings → Public Sharing, then
  the share icon on any question/dashboard) generates no-login URLs —
  but they point at *this machine*, so they only work for others once
  Metabase is hosted (below). This is the main reason to graduate to
  Railway when link-sharing matters.
- Trusted collaborators can also get real logins (Admin → People) with
  view-only groups.

## Later: move to Railway (when links need to work for others)

1. New Railway service from the `metabase/metabase` image; attach a small
   Postgres for `MB_DB_*` app state (same env vars as the compose file).
2. `pg_dump` the local `metabase-appdb` volume's DB and restore it into
   that Postgres — every saved question/dashboard/user carries over.
3. Point Metabase's corpus connection at the **internal** hostname
   (`postgres.railway.internal`) instead of the public proxy.
4. Custom domain (e.g. `data.loom.nerv-analytic.ai`) via CNAME, same as
   the API. ~$5–10/mo at Metabase's idle footprint.

## Maintenance notes

- New columns/tables in the corpus schema won't appear until Metabase
  re-syncs (nightly by default; Admin → Databases → Sync now to force).
- If `corpus_export.py`'s output schema changes, update
  `corpus_export_view` in `setup.sql` in the same commit (same rule as
  the capability matrix).
- `metabase_ro` has SELECT on future views only if re-granted — the
  setup script grants explicitly, so re-run it after adding views.
