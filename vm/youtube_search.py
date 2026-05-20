"""
YouTube affiliate-channel search worker (Phase 1).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'youtube'. Mirrors scraper.py's CLI shape
(arg names, [RESULT] marker, output JSON) so the worker dispatch path
stays uniform.

Flow:
  1. search.list   — keyword → up to maxResults videos (regionCode + relevanceLanguage applied)
  2. channels.list — batch up to 50 distinct channelIds → snippet + statistics
  3. Supabase      — insert one row per unique channel into public.youtube_channels
  4. Output JSON   — summary for worker.py (total_results, no per-lead rows)

Cost per job (free quota = 10,000 units/day):
  - 1× search.list   = 100 units
  - 1× channels.list = 1 unit (batches up to 50 ids per call)
  → ~99 jobs/day before quota cap.

Errors:
  - 400 invalid key, 403 quotaExceeded, 5xx transient — all exit non-zero
    with [RESULT] FAILED so worker.py routes to fail_scrape_job (which
    handles requeue / final-failure logic).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import OrderedDict
from typing import Any

import requests
from supabase import create_client


YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"


def search_videos(
    keyword: str,
    region_code: str | None,
    language: str | None,
    max_results: int,
    api_key: str,
) -> "OrderedDict[str, dict[str, Any]]":
    """search.list — keyword → unique channelIds (ordered by relevance).

    Returns an OrderedDict keyed by channelId. Value = the first
    discovery context (video title + id) for that channel — useful so
    we know WHICH of the channel's videos surfaced it for this keyword.
    """
    params: dict[str, Any] = {
        "part": "snippet",
        "q": keyword,
        "type": "video",
        "maxResults": max(1, min(max_results, 50)),
        "key": api_key,
    }
    if region_code:
        params["regionCode"] = region_code
    if language:
        params["relevanceLanguage"] = language

    r = requests.get(f"{YOUTUBE_API_BASE}/search", params=params, timeout=30)
    if r.status_code != 200:
        # Surface the API's error body — usually a one-line reason like
        # "API key not valid" or "quotaExceeded" that the operator needs.
        raise RuntimeError(f"search.list HTTP {r.status_code}: {r.text[:500]}")
    data = r.json()

    channels: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
    for item in data.get("items") or []:
        snippet = item.get("snippet") or {}
        channel_id = snippet.get("channelId")
        if not channel_id or channel_id in channels:
            continue
        channels[channel_id] = {
            "channel_name_from_search": snippet.get("channelTitle"),
            "discovered_video_id": (item.get("id") or {}).get("videoId"),
            "discovered_video_title": snippet.get("title"),
        }
    return channels


def fetch_channel_details(
    channel_ids: list[str], api_key: str
) -> dict[str, dict[str, Any]]:
    """channels.list — bulk lookup snippet + statistics for up to 50 ids
    at a time. Always 1 unit per call regardless of batch size.
    """
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(channel_ids), 50):
        batch = channel_ids[i : i + 50]
        params = {
            "part": "snippet,statistics",
            "id": ",".join(batch),
            "key": api_key,
        }
        r = requests.get(f"{YOUTUBE_API_BASE}/channels", params=params, timeout=30)
        if r.status_code != 200:
            # Channel-details failure is non-fatal — we still have basic
            # info from search.list. Log and continue with what we have.
            print(
                f"[WARN] channels.list HTTP {r.status_code}: {r.text[:300]}",
                file=sys.stderr,
            )
            return out
        for item in (r.json() or {}).get("items") or []:
            cid = item.get("id")
            if not cid:
                continue
            snip = item.get("snippet") or {}
            stats = item.get("statistics") or {}
            thumb = ((snip.get("thumbnails") or {}).get("high") or {}).get("url")
            out[cid] = {
                "channel_name": snip.get("title"),
                "channel_handle": snip.get("customUrl"),
                "channel_description": snip.get("description"),
                "country": snip.get("country"),
                "published_at": snip.get("publishedAt"),
                "thumbnail_url": thumb,
                "subscriber_count": _to_int(stats.get("subscriberCount")),
                "video_count": _to_int(stats.get("videoCount")),
                "view_count": _to_int(stats.get("viewCount")),
            }
    return out


def _to_int(v: Any) -> int | None:
    """YouTube returns counts as strings — convert to int, or None when
    hiddenSubscriberCount is true (subscriberCount field missing)."""
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def write_channels_to_db(
    sb_url: str,
    sb_key: str,
    job_id: str,
    keyword: str,
    channels: "OrderedDict[str, dict[str, Any]]",
    details: dict[str, dict[str, Any]],
) -> int:
    """Insert one row per unique channel. Returns rows-inserted count."""
    if not channels:
        return 0
    sb = create_client(sb_url, sb_key)
    rows: list[dict[str, Any]] = []
    for channel_id, search_meta in channels.items():
        d = details.get(channel_id) or {}
        rows.append({
            "scrape_queue_id": job_id,
            "channel_id": channel_id,
            "channel_url": f"https://www.youtube.com/channel/{channel_id}",
            "channel_name": d.get("channel_name") or search_meta.get("channel_name_from_search"),
            "channel_handle": d.get("channel_handle"),
            "channel_description": d.get("channel_description"),
            "discovered_from_keyword": keyword,
            "discovered_video_id": search_meta.get("discovered_video_id"),
            "discovered_video_title": search_meta.get("discovered_video_title"),
            "subscriber_count": d.get("subscriber_count"),
            "video_count": d.get("video_count"),
            "view_count": d.get("view_count"),
            "country": d.get("country"),
            "published_at": d.get("published_at"),
            "thumbnail_url": d.get("thumbnail_url"),
        })
    sb.table("youtube_channels").insert(rows).execute()
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="YouTube Data API search → youtube_channels")
    parser.add_argument("-k", "--keyword", required=True)
    parser.add_argument("-c", "--country", default="", help="Country display name (unused; logged only)")
    parser.add_argument("--country-code", default="", help="ISO-2 country code → YouTube regionCode")
    parser.add_argument("--language", default="en", help="2-letter language code → relevanceLanguage")
    parser.add_argument("--max-results", type=int, default=50, help="search.list maxResults (1-50, default 50)")
    parser.add_argument("--job-id", required=True, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", default="", help="Worker identifier (logged only)")
    parser.add_argument("--output", required=True, help="Path to write the summary JSON")
    args = parser.parse_args()

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        print("[ERROR] YOUTUBE_API_KEY not set in environment", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not sb_url or not sb_key:
        print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    region_code = (args.country_code or "").strip().upper() or None
    language = (args.language or "en").strip().lower() or "en"

    print(
        f"[INFO] YouTube search | keyword={args.keyword!r} region={region_code or '-'} "
        f"lang={language} maxResults={args.max_results} job={args.job_id[:8]}"
    )

    try:
        channels = search_videos(
            args.keyword,
            region_code=region_code,
            language=language,
            max_results=args.max_results,
            api_key=api_key,
        )
    except Exception as exc:
        print(f"[ERROR] YouTube search.list failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(2)

    if not channels:
        print("[WARN] YouTube search returned no unique channels for this keyword")
        _write_summary(args.output, args.keyword, region_code, language, 0)
        print("[DONE] YOUTUBE | Total: 0 channels")
        print("[RESULT] SUCCESS")
        return

    print(f"[INFO] Found {len(channels)} unique channels — fetching channels.list details")

    try:
        details = fetch_channel_details(list(channels.keys()), api_key)
    except Exception as exc:
        # channels.list is best-effort. Continue with search.list-only data.
        print(f"[WARN] channels.list crashed: {exc} — proceeding without enriched details", file=sys.stderr)
        details = {}

    try:
        inserted = write_channels_to_db(
            sb_url, sb_key, args.job_id, args.keyword, channels, details,
        )
    except Exception as exc:
        print(f"[ERROR] Supabase insert into youtube_channels failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(3)

    _write_summary(args.output, args.keyword, region_code, language, inserted)
    print(f"[DONE] YOUTUBE | Total: {inserted} channels inserted into youtube_channels")
    print("[RESULT] SUCCESS")


def _write_summary(output_path: str, keyword: str, region: str | None, language: str, total: int) -> None:
    """Drop a minimal summary JSON for worker.py to pass to
    complete_scrape_job. Shape mirrors scraper.py's so the worker
    dispatch code stays uniform — total_results is what gets surfaced
    in the /scrape UI.
    """
    summary = {
        "params": {"keyword": keyword, "region": region, "language": language},
        "total_results": total,
        "organic_results": total,   # all YouTube channels are "organic" in our schema
        "ppc_results": 0,
        "pages_scraped": 1,         # YouTube search is single-page from our POV
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": None,
        "results": [],              # channels live in youtube_channels, not in this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


if __name__ == "__main__":
    main()
