"""Backfill Netflix media titles with episode-level names — TEMPORARY.

Why this exists (CORPUS_WIRING.md §7.2): extension builds ≤0.3.1 store
``corpus_media.title = "Netflix"`` (the literal document.title of a watch
page).  The forward fix (CaptionPlatform.readMediaTitle, 2026-07-06) ships
with extension 0.4.0 — until that's live on AMO + Chrome, new captures
keep landing with junk titles.  This script heals them server-side, and
also UPGRADES show-level titles to episode-level, which even 0.4.0's
og:title-style sources can't always do retroactively.

**Delete the daily workflow (.github/workflows/backfill-netflix-titles.yml)
once 0.4.0 has been live for a week or so** — the script itself can stay
for one-off use.

How it resolves (all logged-out, public pages):

1. ``https://www.netflix.com/title/<episodeId>`` 302s to the SHOW page.
2. The show page embeds Netflix's GraphQL cache, containing
   ``Episode:{"videoId":<id>}`` nodes with ``title`` (episode name) and
   ``number``, plus ``Season`` nodes whose ordered ``episodes.edges``
   lists locate the episode's season ("Season 1" → S1).
3. The show name comes from the ``og:title`` meta ("Watch X | Netflix").
4. Composed title: ``Show — S1E5 Episode Name`` (episode node found),
   else just ``Show`` (films, or episodes the cache doesn't embed).

Selection: netflix rows whose title is NULL / 'Netflix' / show-level
(no " — " marker).  Rows already carrying an episode marker — from this
script OR a 0.4.0 capture — are never touched, so the two sources
coexist.  Films re-resolve to the same value (no-op UPDATE).

Usage:
    DATABASE_URL=postgresql://... python scripts/backfill_netflix_titles.py
    ... --dry-run          # resolve + report, write nothing
    ... --limit 10         # cap rows processed this run
    ... --sleep 1.0        # seconds between Netflix fetches (default 1.0)

Deps: psycopg[binary] (scripts/requirements-export.txt covers it).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request

UA = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"
)

# The em-dash separator doubles as the "episode-level already" marker; the
# extension's readNetflixVideoTitle composes titles with the same "—".
EPISODE_MARKER = "—"


def fetch_title_page(media_id: str, retries: int = 2) -> str | None:
    """GET the (redirected) show page for an episode/show/film id.
    Netflix's edge occasionally truncates the ~1.1 MB response
    (IncompleteRead) or drops the connection — retry a couple of times."""
    req = urllib.request.Request(
        f"https://www.netflix.com/title/{media_id}",
        headers={"User-Agent": UA, "Accept-Language": "en"},
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001 - best-effort resolver
            if attempt < retries:
                time.sleep(2.0 * (attempt + 1))
                continue
            print(f"  fetch failed for {media_id}: {e}")
    return None


def _unescape(s: str) -> str:
    """Unescape a JS-string-embedded JSON fragment ("\\u00e9", "\\'")."""
    try:
        return json.loads('"' + s.replace("\\'", "'") + '"')
    except Exception:  # noqa: BLE001
        return s


def parse_show_name(html: str) -> str | None:
    """og:title content is 'Watch <Show> | Netflix[ Official Site]'."""
    m = re.search(r'og:title" content="([^"]*)"', html)
    if not m:
        return None
    name = _unescape(m.group(1))
    name = re.sub(r"^Watch ", "", name)
    name = re.sub(r"\s*\|\s*Netflix.*$", "", name).strip()
    # HTML entities survive the meta attribute (&#x27; &amp;)
    name = (
        name.replace("&#x27;", "'").replace("&quot;", '"').replace("&amp;", "&")
    )
    return name or None


# Season node: shortTitle ("Season 1") followed closely by its ordered
# episodes edges list.  Keys are escaped inside a JS string:
# Season:{\\"videoId\\":81712071}
_SEASON_RE = re.compile(
    r'Season:\{\\+"videoId\\+":\d+\}":\{"__typename":"Season".{0,300}?'
    r'"shortTitle":"((?:[^"\\]|\\.)*)".{0,2000}?"edges":\[(.{0,20000}?)\]'
)


def _season_sets(html: str) -> list[tuple[str, set[str]]]:
    """[(season_label, {episode videoIds in that season's edges}), ...]"""
    out: list[tuple[str, set[str]]] = []
    for sm in _SEASON_RE.finditer(html):
        vids = set(re.findall(r'videoId\\+":(\d+)\}', sm.group(2)))
        out.append((_unescape(sm.group(1)), vids))
    return out


def parse_episode(html: str, media_id: str) -> tuple[str | None, int | None, str | None]:
    """(episode_title, episode_number, season_label) from the embedded
    GraphQL cache, or (None, None, None) when the id isn't an episode
    (films) or isn't embedded (the cache windows ~10 episodes/season)."""
    node = re.search(
        r'Episode:\{\\+"videoId\\+":' + re.escape(media_id) + r'\}":\{(.{0,600})',
        html,
    )
    if not node:
        return None, None, None
    body = node.group(1)
    t = re.search(r'"title":"((?:[^"\\]|\\.)*)"', body)
    n = re.search(r'"number":(\d+)', body)
    ep_title = _unescape(t.group(1)) if t else None
    ep_number = int(n.group(1)) if n else None
    season_label = next(
        (lbl for lbl, vids in _season_sets(html) if media_id in vids), None
    )
    return ep_title, ep_number, season_label


# Extrapolation window: Netflix allocates a season's episode ids as a
# contiguous block (verified on Frieren 81726716=E1 … 81726725=E10 →
# 81726741=E26, and Apothecary 81712072=E1 … 81712086=E15), but don't
# stretch the assumption across arbitrary distances.
_MAX_ANCHOR_DELTA = 40


def extrapolate_episode(html: str, media_id: str) -> tuple[int | None, str | None]:
    """(episode_number, season_label) inferred from the NEAREST embedded
    episode node, for ids outside the cache's ~10-per-season window.
    Number only — the episode NAME genuinely isn't on the page.  Nearest
    anchor is same-season in practice (season blocks live in distinct id
    ranges), and the delta cap keeps a violated assumption harmless."""
    try:
        mid = int(media_id)
    except ValueError:
        return None, None
    anchors = re.findall(
        r'Episode:\{\\+"videoId\\+":(\d+)\}":\{"__typename":"Episode",'
        r'"videoId":\d+,"title":"(?:[^"\\]|\\.)*"[^{}]*?"number":(\d+)',
        html,
    )
    if not anchors:
        return None, None
    vid, num = min(anchors, key=lambda a: abs(int(a[0]) - mid))
    delta = mid - int(vid)
    if delta == 0 or abs(delta) > _MAX_ANCHOR_DELTA:
        return None, None
    number = int(num) + delta
    if number < 1:
        return None, None
    season_label = next(
        (lbl for lbl, vids in _season_sets(html) if vid in vids), None
    )
    return number, season_label


def compose_title(
    show: str,
    ep_title: str | None,
    ep_number: int | None,
    season_label: str | None,
) -> str:
    if ep_title is None and ep_number is None:
        return show
    marker = ""
    sm = re.search(r"(\d+)", season_label or "")
    if sm and ep_number is not None:
        marker = f"S{sm.group(1)}E{ep_number}"
    elif ep_number is not None:
        marker = f"E{ep_number}"
    detail = " ".join(p for p in (marker, ep_title or "") if p).strip()
    return f"{show} {EPISODE_MARKER} {detail}" if detail else show


def resolve(media_id: str) -> str | None:
    html = fetch_title_page(media_id)
    if html is None:
        return None
    show = parse_show_name(html)
    if show is None:
        return None
    ep_title, ep_number, season_label = parse_episode(html, media_id)
    if ep_title is None and ep_number is None:
        ep_number, season_label = extrapolate_episode(html, media_id)
    return compose_title(show, ep_title, ep_number, season_label)[:512]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--sleep", type=float, default=1.0)
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        print("backfill_netflix_titles: DATABASE_URL unset — nothing to do.")
        return 0

    import psycopg  # deferred: everything above is stdlib-testable

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            """
            SELECT id, platform_media_id, title FROM corpus_media
            WHERE platform = 'netflix'
              AND platform_media_id ~ '^[0-9]+$'
              AND (title IS NULL OR title = 'Netflix' OR position(%s in title) = 0)
            ORDER BY id
            LIMIT %s
            """,
            (EPISODE_MARKER, args.limit),
        ).fetchall()
        print(f"backfill_netflix_titles: {len(rows)} candidate row(s).")

        updated = 0
        for pk, media_id, old_title in rows:
            new_title = resolve(media_id)
            time.sleep(args.sleep)
            if new_title is None:
                print(f"  id={pk} {media_id}: unresolved (kept {old_title!r})")
                continue
            if new_title == old_title:
                print(f"  id={pk} {media_id}: unchanged ({old_title!r})")
                continue
            print(f"  id={pk} {media_id}: {old_title!r} → {new_title!r}"
                  + (" (dry-run)" if args.dry_run else ""))
            if not args.dry_run:
                conn.execute(
                    "UPDATE corpus_media SET title = %s WHERE id = %s",
                    (new_title, pk),
                )
                conn.commit()
                updated += 1
        print(f"backfill_netflix_titles: updated {updated} row(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
