"""
Kick affiliate-streamer search worker (Phase 1).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'kick'. Mirrors youtube_search.py's
CLI shape (arg names, [RESULT] marker, output JSON) so the worker
dispatch path stays uniform.

Flow:
  1. OAuth       — App Access Token via client_credentials grant
                   (60-day TTL; fetched fresh per run for Phase 1
                   simplicity, optimize to cached later)
  2. Categories  — v1 /public/v1/categories?q={keyword} → category IDs
  3. Livestreams — for each cat_id, paginate /public/v1/livestreams
                   → live streamer slugs
  4. Channels    — per-slug enrichment via /public/v1/channels?slug={s}
  5. Supabase    — insert one row per unique slug into kick_streamers
  6. Output JSON — summary for worker.py (total_results, no per-lead rows)

Phase 1 scope: pure API. Captures only currently-live streamers in
matching categories. Phase 2 will add a browser-based discovery pass
of kick.com/{slug} to fill social handles, follower count, promo
cards, and pinned chat messages — surfaces not exposed by the API.

Why v1 (deprecated) instead of v2 for categories search:
  v2's ?name= filter is exact-substring and misses "Slots & Casino"
  (id=28) for the keyword "casino". v1's ?q= is fuzzy and surfaces it.
  If Kick removes v1, the CATEGORY_FALLBACK map below kicks in.

Errors:
  exit 1 — env vars missing
  exit 2 — Kick API failure (auth, categories, or livestreams)
  exit 3 — Supabase insert failure
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

import requests

# supabase-py is only needed when actually writing to the DB; the
# import lives inside write_streamers_to_db so --dry-run works on
# environments where supabase-py isn't installed (e.g. Jose's laptop).


KICK_AUTH_BASE = "https://id.kick.com"
KICK_API_BASE  = "https://api.kick.com/public/v1"

# Fallback keyword → category-id mapping used only if v1
# /categories?q= goes away. Extend as Kick adds gambling-adjacent
# categories. IDs verified 2026-05-29.
CATEGORY_FALLBACK: dict[str, list[int]] = {
    "casino":   [28],   # Slots & Casino
    "slots":    [28],
    "gambling": [28],
}


def fetch_access_token(client_id: str, client_secret: str) -> str:
    """Client Credentials grant — returns a 60-day App Access Token."""
    r = requests.post(
        f"{KICK_AUTH_BASE}/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"oauth/token HTTP {r.status_code}: {r.text[:500]}")
    token = (r.json() or {}).get("access_token")
    if not token:
        raise RuntimeError("oauth/token returned no access_token")
    return token


def search_categories(keyword: str, token: str) -> list[int]:
    """Fuzzy keyword → category IDs via the v1 endpoint.

    Falls back to CATEGORY_FALLBACK if v1 is unavailable so the
    scraper keeps working through a v1 deprecation.
    """
    try:
        r = requests.get(
            f"{KICK_API_BASE}/categories",
            params={"q": keyword},
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=20,
        )
        if r.status_code == 200:
            ids = [c["id"] for c in (r.json().get("data") or []) if c.get("id")]
            if ids:
                return ids
        else:
            print(f"[WARN] v1 categories HTTP {r.status_code} — using fallback", file=sys.stderr)
    except Exception as exc:
        print(f"[WARN] v1 categories crashed ({exc}) — using fallback", file=sys.stderr)
    return CATEGORY_FALLBACK.get(keyword.lower().strip(), [])


def fetch_live_streamers(
    category_id: int, token: str, max_results: int = 100
) -> list[dict[str, Any]]:
    """Paginate /livestreams?category_id=X. Caps at max_results items."""
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    while len(out) < max_results:
        params: dict[str, Any] = {
            "category_id": category_id,
            "limit": min(25, max_results - len(out)),
        }
        if cursor:
            params["cursor"] = cursor
        r = requests.get(
            f"{KICK_API_BASE}/livestreams",
            params=params,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=20,
        )
        if r.status_code != 200:
            raise RuntimeError(f"/livestreams HTTP {r.status_code}: {r.text[:300]}")
        body = r.json() or {}
        batch = body.get("data") or []
        if not batch:
            break
        out.extend(batch)
        cursor = (body.get("pagination") or {}).get("next_cursor") or None
        if not cursor:
            break
    return out


def fetch_channel(slug: str, token: str) -> dict[str, Any] | None:
    """Per-slug /channels lookup. Returns None on miss.

    NOTE: the Kick docs imply batch lookup of up to 50 slugs is
    supported, but the URL-encoded `slug[]=` syntax silently returns
    an empty array (verified 2026-05-29). Plain `?slug=foo` works for
    a single slug; batching across multiple slugs in one call is
    unverified, so Phase 1 fetches one at a time. Acceptable cost:
    ~100ms × max_results = a few seconds per job.
    """
    r = requests.get(
        f"{KICK_API_BASE}/channels",
        params={"slug": slug},
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=15,
    )
    if r.status_code != 200:
        print(f"[WARN] /channels?slug={slug} HTTP {r.status_code}", file=sys.stderr)
        return None
    rows = (r.json() or {}).get("data") or []
    return rows[0] if rows else None


def _build_rows(
    job_id: str, keyword: str, streamers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Shape the API channel objects into kick_streamers row dicts.
    Split out from write_streamers_to_db so --dry-run can call it
    without needing supabase-py installed."""
    rows: list[dict[str, Any]] = []
    for s in streamers:
        stream = s.get("stream") or {}
        category = s.get("category") or {}
        rows.append({
            "scrape_queue_id": job_id,
            "broadcaster_user_id": s["broadcaster_user_id"],
            "slug": s["slug"],
            "channel_url": f"https://kick.com/{s['slug']}",
            "banner_picture": s.get("banner_picture"),
            "discovered_from_keyword": keyword,
            "channel_description": s.get("channel_description"),
            "category_id": category.get("id"),
            "category_name": category.get("name"),
            "active_subscribers_count": s.get("active_subscribers_count"),
            "canceled_subscribers_count": s.get("canceled_subscribers_count"),
            "is_live": stream.get("is_live"),
            "is_mature": stream.get("is_mature"),
            "stream_language": stream.get("language"),
            "stream_title": s.get("stream_title"),
            "stream_started_at": stream.get("start_time"),
            "stream_viewer_count": stream.get("viewer_count"),
            "stream_thumbnail": stream.get("thumbnail"),
            "custom_tags": stream.get("custom_tags"),
        })
    return rows


def write_streamers_to_db(
    sb_url: str,
    sb_key: str,
    job_id: str,
    keyword: str,
    streamers: list[dict[str, Any]],
) -> int:
    """Insert one row per unique streamer into kick_streamers.
    Returns the row count inserted."""
    rows = _build_rows(job_id, keyword, streamers)
    if not rows:
        return 0
    # Lazy import — keeps --dry-run runnable without supabase-py installed.
    from supabase import create_client
    sb = create_client(sb_url, sb_key)
    sb.table("kick_streamers").insert(rows).execute()
    return len(rows)


def _write_summary(
    output_path: str,
    keyword: str,
    language: str,
    total: int,
    categories_matched: int,
) -> None:
    """Summary JSON for worker.py → complete_scrape_job. Shape mirrors
    scraper.py + youtube_search.py so the dispatch path stays uniform —
    total_results is what surfaces on the /scrape UI."""
    summary = {
        "params": {
            "keyword": keyword,
            "language": language,
            "categories_matched": categories_matched,
        },
        "total_results": total,
        "organic_results": total,   # all Kick streamers are "organic" in our schema
        "ppc_results": 0,
        "pages_scraped": 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": None,
        "results": [],              # streamers live in kick_streamers, not in this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Kick affiliate-streamer search → kick_streamers")
    parser.add_argument("-k", "--keyword", required=True)
    parser.add_argument("-c", "--country", default="", help="Country display name (unused for Kick; logged only)")
    parser.add_argument("--country-code", default="", help="ISO-2 country code (unused for Kick)")
    parser.add_argument("--language", default="en", help="2-letter language code (Phase 1: logged only)")
    parser.add_argument("--max-results", type=int, default=100, help="Max total live streamers to fetch (default 100)")
    parser.add_argument("--job-id", required=True, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", default="", help="Worker identifier (logged only)")
    parser.add_argument("--output", required=True, help="Path to write the summary JSON")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run all API calls and print sample rows, but skip the Supabase insert. "
             "Useful for local validation before the migration has been applied.",
    )
    args = parser.parse_args()

    client_id = os.environ.get("KICK_CLIENT_ID")
    client_secret = os.environ.get("KICK_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("[ERROR] KICK_CLIENT_ID / KICK_CLIENT_SECRET not set", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not args.dry_run and (not sb_url or not sb_key):
        print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    language = (args.language or "en").strip().lower() or "en"
    print(
        f"[INFO] Kick search | keyword={args.keyword!r} lang={language} "
        f"maxResults={args.max_results} job={args.job_id[:8]}"
    )

    # 1. OAuth token (Client Credentials grant — 60-day TTL)
    try:
        token = fetch_access_token(client_id, client_secret)
    except Exception as exc:
        print(f"[ERROR] Kick OAuth failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(2)

    # 2. Resolve keyword → category IDs (fuzzy match via v1)
    try:
        category_ids = search_categories(args.keyword, token)
    except Exception as exc:
        print(f"[ERROR] Kick categories lookup failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(2)

    if not category_ids:
        print(f"[WARN] No Kick categories matched keyword {args.keyword!r}")
        _write_summary(args.output, args.keyword, language, 0, 0)
        print("[DONE] KICK | Total: 0 streamers (no matching categories)")
        print("[RESULT] SUCCESS")
        return

    print(f"[INFO] Matched {len(category_ids)} categories: {category_ids[:10]}")

    # 3. Livestreams per category (dedupe by slug across categories)
    seen_slugs: set[str] = set()
    discovery: list[str] = []
    for cat_id in category_ids:
        if len(discovery) >= args.max_results:
            break
        try:
            streams = fetch_live_streamers(cat_id, token, max_results=args.max_results)
        except Exception as exc:
            # One category failing shouldn't kill the whole job — log and continue.
            print(f"[WARN] /livestreams?category_id={cat_id} crashed: {exc}", file=sys.stderr)
            continue
        for s in streams:
            slug = s.get("slug")
            if not slug or slug in seen_slugs:
                continue
            seen_slugs.add(slug)
            discovery.append(slug)
            if len(discovery) >= args.max_results:
                break

    if not discovery:
        print("[WARN] No live streamers found in matched categories")
        _write_summary(args.output, args.keyword, language, 0, len(category_ids))
        print("[DONE] KICK | Total: 0 streamers (no live channels)")
        print("[RESULT] SUCCESS")
        return

    print(f"[INFO] Discovered {len(discovery)} live streamers — enriching via /channels")

    # 4. Per-slug enrichment (see fetch_channel docstring for batching note)
    enriched: list[dict[str, Any]] = []
    for slug in discovery:
        ch = fetch_channel(slug, token)
        if ch:
            enriched.append(ch)

    if not enriched:
        print("[WARN] Channel enrichment returned no data", file=sys.stderr)
        _write_summary(args.output, args.keyword, language, 0, len(category_ids))
        print("[DONE] KICK | Total: 0 (enrichment empty)")
        print("[RESULT] SUCCESS")
        return

    # 5. Supabase insert (skipped in --dry-run)
    if args.dry_run:
        rows = _build_rows(args.job_id, args.keyword, enriched)
        print(f"[DRY-RUN] Would insert {len(rows)} rows into kick_streamers.")
        if rows:
            print("[DRY-RUN] Sample row (first streamer):")
            print(json.dumps(rows[0], indent=2, default=str))
        print(f"[DONE] KICK | Total: {len(rows)} streamers (dry-run, no DB write)")
        print("[RESULT] SUCCESS")
        return

    try:
        inserted = write_streamers_to_db(
            sb_url, sb_key, args.job_id, args.keyword, enriched,
        )
    except Exception as exc:
        print(f"[ERROR] Supabase insert into kick_streamers failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(3)

    # 6. Summary JSON for worker.py
    _write_summary(args.output, args.keyword, language, inserted, len(category_ids))
    print(f"[DONE] KICK | Total: {inserted} streamers inserted into kick_streamers")
    print("[RESULT] SUCCESS")


if __name__ == "__main__":
    main()
