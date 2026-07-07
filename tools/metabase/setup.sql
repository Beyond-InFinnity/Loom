-- One-shot setup on the RAILWAY corpus Postgres for Metabase browsing.
-- Idempotent — safe to re-run.
--
-- Run (no local psql needed; uses a throwaway container):
--   docker run --rm -i postgres:16-alpine \
--     psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 \
--     -v ro_password=<pick-a-password> < tools/metabase/setup.sql
--   (no quotes inside the -v value — :'ro_password' quotes it itself)
--
-- Creates:
--   1. metabase_ro        — SELECT-only login role Metabase connects as.
--                           Metabase can never write to the corpus.
--   2. corpus_browse      — human-friendly flat view: one row per subtitle
--                           line with title / language / timestamps / text /
--                           its default romanization as plain text.  This is
--                           the "Excel sheet" and the demo surface.
--   3. corpus_export_view — exact per-row parity with the R2 Parquet export
--                           schema (corpus_export.PARQUET_COLUMNS), computed
--                           live.  "What does the R2 data look like?" =
--                           browse this view.
--   4. corpus_stats       — per platform x language rollup (tracks, lines,
--                           media titles, capture window) for dashboards.
--   5. An index on romanization_cache so the view joins stay fast as the
--      cache grows (also benefits the export script's enrichment join).

-- --- 1. read-only role ------------------------------------------------------

-- psql doesn't expand :variables inside dollar-quoted blocks, so stage the
-- password in a session GUC the DO block can read.
SELECT set_config('loom.ro_password', :'ro_password', false);

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'metabase_ro') THEN
        EXECUTE format('CREATE ROLE metabase_ro LOGIN PASSWORD %L',
                       current_setting('loom.ro_password'));
    ELSE
        EXECUTE format('ALTER ROLE metabase_ro WITH LOGIN PASSWORD %L',
                       current_setting('loom.ro_password'));
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO metabase_ro', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO metabase_ro;

-- --- 5. cache lookup index (before the views that lean on it) ---------------

CREATE INDEX IF NOT EXISTS romanization_cache_text_lookup_idx
    ON romanization_cache (lang_code, input_text, kind);

-- --- 2. human-friendly browse view ------------------------------------------

CREATE OR REPLACE VIEW corpus_browse AS
SELECT
    m.platform,
    m.title,
    m.platform_media_id                      AS media_id,
    m.origin_lang,
    t.lang_code                              AS track_lang,
    t.is_cc,
    t.kind                                   AS track_kind,
    l.seq,
    to_char(make_interval(secs => l.start_ms / 1000.0), 'HH24:MI:SS') AS starts,
    to_char(make_interval(secs => l.end_ms   / 1000.0), 'HH24:MI:SS') AS ends,
    l.text,
    rom.romanized,
    rom.phonetic_system,
    l.style,
    t.captured_at,
    t.id                                     AS track_pk
FROM corpus_line l
JOIN corpus_track t ON t.id = l.track_id
JOIN corpus_media m ON m.id = t.media_id
LEFT JOIN LATERAL (
    -- best available romanization for this line: highest engine version,
    -- one row (the language's default system is in practice the only one)
    SELECT c.output_json ->> 'romanized' AS romanized,
           c.phonetic_system
    FROM romanization_cache c
    WHERE c.kind = 'romanize'
      AND c.lang_code = t.lang_code
      AND c.input_text = l.text
    ORDER BY c.engine_version DESC, c.phonetic_system
    LIMIT 1
) rom ON TRUE;

GRANT SELECT ON corpus_browse TO metabase_ro;

-- --- 3. R2 Parquet parity view ----------------------------------------------
-- Column-for-column what build_records() writes to the Parquet files
-- (loom_api/corpus_export.py PARQUET_COLUMNS), computed live over ALL rows
-- (archived + not-yet-exported).  Latest engine_version per (kind, system)
-- wins, matching the export's dedup rule.

CREATE OR REPLACE VIEW corpus_export_view AS
SELECT
    m.platform,
    m.platform_media_id                       AS media_id,
    m.title,
    m.origin_lang,
    t.platform_track_id                       AS track_id,
    t.lang_code                               AS track_lang,
    t.is_cc,
    t.kind                                    AS track_kind,
    t.captured_at::text                       AS captured_at,
    l.seq,
    l.start_ms,
    l.end_ms,
    l.text,
    l.style,
    t.styles_json::text                       AS track_styles_json,
    COALESCE(rom.j, '{}'::jsonb)::text        AS romanizations_json,
    COALESCE(ann.j, '{}'::jsonb)::text        AS annotations_json,
    COALESCE(rom.v, '{}'::jsonb) || COALESCE(ann.v, '{}'::jsonb)
                                              AS engine_versions_json,
    -- extra vs Parquet (handy for filtering; ignore for strict parity):
    t.archived_at
FROM corpus_line l
JOIN corpus_track t ON t.id = l.track_id
JOIN corpus_media m ON m.id = t.media_id
LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(phonetic_system, output_json -> 'romanized')      AS j,
           jsonb_object_agg('romanize:' || phonetic_system, engine_version)   AS v
    FROM (
        SELECT DISTINCT ON (c.phonetic_system)
               c.phonetic_system, c.output_json, c.engine_version
        FROM romanization_cache c
        WHERE c.kind = 'romanize'
          AND c.lang_code = t.lang_code
          AND c.input_text = l.text
        ORDER BY c.phonetic_system, c.engine_version DESC
    ) best
) rom ON TRUE
LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(phonetic_system, output_json -> 'spans')          AS j,
           jsonb_object_agg('annotate:' || phonetic_system, engine_version)   AS v
    FROM (
        SELECT DISTINCT ON (c.phonetic_system)
               c.phonetic_system, c.output_json, c.engine_version
        FROM romanization_cache c
        WHERE c.kind = 'annotate'
          AND c.lang_code = t.lang_code
          AND c.input_text = l.text
        ORDER BY c.phonetic_system, c.engine_version DESC
    ) best
) ann ON TRUE;

GRANT SELECT ON corpus_export_view TO metabase_ro;

-- --- 4. rollup stats ----------------------------------------------------------

CREATE OR REPLACE VIEW corpus_stats AS
SELECT
    m.platform,
    t.lang_code                          AS track_lang,
    count(DISTINCT m.id)                 AS media_count,
    count(DISTINCT t.id)                 AS track_count,
    count(l.*)                           AS line_count,
    min(t.captured_at)                   AS first_capture,
    max(t.captured_at)                   AS latest_capture,
    count(DISTINCT t.id) FILTER (WHERE t.archived_at IS NOT NULL) AS tracks_in_r2
FROM corpus_media m
JOIN corpus_track t ON t.media_id = m.id
LEFT JOIN corpus_line l ON l.track_id = t.id
GROUP BY m.platform, t.lang_code
ORDER BY line_count DESC;

GRANT SELECT ON corpus_stats TO metabase_ro;

-- --- base tables: read-only access for ad-hoc exploration --------------------

GRANT SELECT ON corpus_media, corpus_track, corpus_line,
                corpus_export_manifest, romanization_cache TO metabase_ro;
