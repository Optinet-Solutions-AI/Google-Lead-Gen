"""
YouTube affiliate-channel search worker (Phase 1).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'youtube'. Mirrors scraper.py's CLI shape
(arg names, [RESULT] marker, output JSON) so the worker dispatch path
stays uniform.

Flow:
  1. search.list   — keyword → up to maxResults videos (regionCode + relevanceLanguage applied)
  2. channels.list — batch up to 50 distinct channelIds → snippet + statistics
                     + contentDetails (the uploads-playlist id)
  3. playlistItems — per channel, newest upload's publish date → last_video_at.
                     Channels whose last upload predates YOUTUBE_MAX_INACTIVE_DAYS
                     (Gemma 2026-06-27: dead, years-dormant channels showing up)
                     are DROPPED before enrich/insert. Mirrors the Twitch
                     recency gate.
  4. videos.list   — batch up to 50 discovered videoIds → FULL descriptions
                     (search.list's snippet.description is truncated, which
                     drops most affiliate links; the full description is
                     what Phase 3 mines for tracking links / S-tags)
  5. Supabase      — insert one row per surviving channel into public.youtube_channels,
                     stashing the discovered video's full description in
                     recent_video_descriptions for Phase 3
  6. Output JSON   — summary for worker.py (total_results, no per-lead rows)

Cost per job (free quota = 10,000 units/day):
  - 1× search.list    = 100 units
  - 1× channels.list  = 1 unit (batches up to 50 ids per call)
  - N× playlistItems  = 1 unit each, one per discovered channel (≤ maxResults)
  - 1× videos.list    = 1 unit (batches up to 50 ids per call)
  → ~152 units for a 50-channel job (~65 jobs/day). The recency gate runs
    BEFORE videos.list, so description fetches only cover surviving channels.

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

# Recency gate (Gemma 2026-06-27: channels not updated in years were showing).
# A channel's newest upload (from its uploads playlist) older than this is
# dropped before enrich/insert. Channels with no measurable last-upload (no
# public uploads, or the lookup failed) are KEPT — uncertainty shouldn't lose a
# lead. 0 disables the gate. Mirrors twitch_search.TWITCH_MAX_INACTIVE_DAYS.
INACTIVE_CUTOFF_DAYS = int(os.environ.get("YOUTUBE_MAX_INACTIVE_DAYS", "365"))


def _iso_epoch(ts: str | None) -> float | None:
    """Parse an ISO-8601 'YYYY-MM-DDTHH:MM:SS...Z' timestamp to epoch seconds,
    or None if absent/unparseable (caller treats None as unknown → keep)."""
    if not ts:
        return None
    try:
        return time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:  # noqa: BLE001
        return None


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
            "part": "snippet,statistics,contentDetails",
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
            content = item.get("contentDetails") or {}
            uploads = (content.get("relatedPlaylists") or {}).get("uploads")
            thumb = ((snip.get("thumbnails") or {}).get("high") or {}).get("url")
            out[cid] = {
                "channel_name": snip.get("title"),
                "channel_handle": snip.get("customUrl"),
                "channel_description": snip.get("description"),
                "country": snip.get("country"),
                "published_at": snip.get("publishedAt"),
                "uploads_playlist_id": uploads,
                "thumbnail_url": thumb,
                "subscriber_count": _to_int(stats.get("subscriberCount")),
                "video_count": _to_int(stats.get("videoCount")),
                "view_count": _to_int(stats.get("viewCount")),
            }
    return out


def fetch_last_upload_dates(
    uploads_by_channel: dict[str, str], api_key: str
) -> dict[str, str]:
    """playlistItems.list on each channel's uploads playlist → the newest
    upload's publish time (ISO-8601). 1 unit per channel (playlists can't be
    batched). Best-effort: a channel whose lookup fails or has no public
    uploads is omitted, so the recency gate treats it as unknown (kept).

    Uploads playlists are ordered newest-first, so maxResults=1 is the latest
    video. Prefer contentDetails.videoPublishedAt (true publish time) over the
    snippet.publishedAt (playlist-add time)."""
    out: dict[str, str] = {}
    for cid, playlist_id in uploads_by_channel.items():
        if not playlist_id:
            continue
        params = {
            "part": "contentDetails,snippet",
            "playlistId": playlist_id,
            "maxResults": 1,
            "key": api_key,
        }
        try:
            r = requests.get(
                f"{YOUTUBE_API_BASE}/playlistItems", params=params, timeout=30
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] playlistItems {cid}: {exc}", file=sys.stderr)
            continue
        if r.status_code != 200:
            # 404 = no uploads playlist / uploads hidden. Non-fatal → unknown.
            continue
        items = (r.json() or {}).get("items") or []
        if not items:
            continue
        cd = items[0].get("contentDetails") or {}
        sn = items[0].get("snippet") or {}
        ts = cd.get("videoPublishedAt") or sn.get("publishedAt")
        if ts:
            out[cid] = ts
    return out


def fetch_video_descriptions(
    video_ids: list[str], api_key: str
) -> dict[str, str]:
    """videos.list — bulk full descriptions for up to 50 ids at a time.
    Always 1 unit per call regardless of batch size.

    search.list only returns a truncated snippet.description; the full text
    (where affiliate links / S-tags live) requires this follow-up call.
    Best-effort: a failure leaves recent_video_descriptions empty rather
    than failing the whole job — Phase 3 just has less to mine.
    """
    out: dict[str, str] = {}
    ids = [v for v in video_ids if v]
    for i in range(0, len(ids), 50):
        batch = ids[i : i + 50]
        params = {
            "part": "snippet",
            "id": ",".join(batch),
            "key": api_key,
        }
        r = requests.get(f"{YOUTUBE_API_BASE}/videos", params=params, timeout=30)
        if r.status_code != 200:
            print(
                f"[WARN] videos.list HTTP {r.status_code}: {r.text[:300]}",
                file=sys.stderr,
            )
            return out
        for item in (r.json() or {}).get("items") or []:
            vid = item.get("id")
            desc = (item.get("snippet") or {}).get("description")
            if vid and desc:
                out[vid] = desc
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
    descriptions: dict[str, str],
    last_uploads: dict[str, str],
) -> int:
    """Insert one row per unique channel. Returns rows-inserted count.

    `descriptions` maps discovered videoId → full description; the
    discovered video's description is stashed in recent_video_descriptions
    so Phase 3 can mine its affiliate links without another API call.
    `last_uploads` maps channelId → newest-upload ISO timestamp (last_video_at).
    """
    if not channels:
        return 0
    sb = create_client(sb_url, sb_key)
    rows: list[dict[str, Any]] = []
    for channel_id, search_meta in channels.items():
        d = details.get(channel_id) or {}
        video_id = search_meta.get("discovered_video_id")
        full_desc = descriptions.get(video_id) if video_id else None
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
            "last_video_at": last_uploads.get(channel_id),
            "thumbnail_url": d.get("thumbnail_url"),
            # Single-element array: the discovered video's full description.
            # Nullable column — leave unset when videos.list missed it.
            "recent_video_descriptions": [full_desc] if full_desc else None,
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
    parser.add_argument(
        "--top-n-by-follower",
        type=int,
        default=0,
        help="Optional cap: after channels.list populates subscriber_count, "
             "sort DESC and keep only the top N. The tail is discarded "
             "entirely (no video-description fetch, no DB insert). "
             "0 (default) = disabled = keep everything. Answers "
             "'top N highest-subscriber YouTube channels for this keyword' "
             "without paying enrichment cost or DB space for the tail.",
    )
    parser.add_argument("--job-id", required=True, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", default="", help="Worker identifier (logged only)")
    parser.add_argument("--output", required=True, help="Path to write the summary JSON")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run all API calls (incl. the recency gate) but skip the Supabase insert")
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

    # Newest-upload date per channel (the "last updated" signal) for the
    # recency gate. Best-effort — a failure leaves a channel as unknown (kept).
    uploads_by_channel = {
        cid: d.get("uploads_playlist_id")
        for cid, d in details.items()
        if d.get("uploads_playlist_id")
    }
    try:
        last_uploads = fetch_last_upload_dates(uploads_by_channel, api_key)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] playlistItems crashed: {exc} — proceeding without recency filtering", file=sys.stderr)
        last_uploads = {}

    # Recency gate — drop channels whose newest upload predates the cutoff
    # (Gemma's years-dormant channels). Unknown last-upload is kept so we never
    # silently lose an active channel whose uploads playlist couldn't be read.
    if INACTIVE_CUTOFF_DAYS > 0 and channels:
        cutoff_epoch = time.time() - INACTIVE_CUTOFF_DAYS * 86400.0
        kept: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
        dropped_stale = unknown = 0
        for cid, meta in channels.items():
            la_epoch = _iso_epoch(last_uploads.get(cid))
            if la_epoch is None:
                unknown += 1
                kept[cid] = meta
            elif la_epoch < cutoff_epoch:
                dropped_stale += 1
            else:
                kept[cid] = meta
        print(
            f"[INFO] Recency gate (cutoff={INACTIVE_CUTOFF_DAYS}d): kept {len(kept)}/{len(channels)} "
            f"— dropped {dropped_stale} stale, {unknown} kept with unknown last-upload"
        )
        channels = kept
        if not channels:
            print("[WARN] All channels filtered out by the recency gate", file=sys.stderr)
            _write_summary(args.output, args.keyword, region_code, language, 0)
            print(f"[DONE] YOUTUBE | Total: 0 channels (all {dropped_stale} were inactive)")
            print("[RESULT] SUCCESS")
            return

    # Optional per-scrape cap: rank by subscriber_count DESC (nulls last)
    # and keep only the top N. The tail is discarded entirely — no
    # description fetch, no DB insert. Runs before the videos.list call
    # so we don't spend API budget on tail channels we won't keep.
    if args.top_n_by_follower and args.top_n_by_follower > 0:
        cap = args.top_n_by_follower
        if len(channels) > cap:
            def _sub_key(item: tuple[str, dict[str, Any]]) -> tuple[int, int]:
                cid, _meta = item
                sub = (details.get(cid) or {}).get("subscriber_count")
                if isinstance(sub, int):
                    return (0, -sub)  # known subs first, DESC
                return (1, 0)         # unknowns last
            ordered = sorted(channels.items(), key=_sub_key)
            dropped_n = len(ordered) - cap
            channels = OrderedDict(ordered[:cap])
            print(
                f"[INFO] --top-n-by-follower={cap}: kept top {cap} by subscriber_count, "
                f"dropped {dropped_n} lower-subscriber channels (no enrichment, no DB insert)"
            )
        else:
            print(
                f"[INFO] --top-n-by-follower={cap}: only {len(channels)} channels available, "
                f"nothing to drop"
            )

    if args.dry_run:
        print(f"[DRY-RUN] Would insert {len(channels)} channels into youtube_channels.")
        for cid, meta in list(channels.items())[:8]:
            d = details.get(cid) or {}
            nm = d.get("channel_name") or meta.get("channel_name_from_search")
            print(f"  - {nm} | last_video_at={last_uploads.get(cid) or 'unknown'} | subs={d.get('subscriber_count')}")
        _write_summary(args.output, args.keyword, region_code, language, len(channels))
        print(f"[DONE] YOUTUBE | Total: {len(channels)} channels (dry-run, no DB write)")
        print("[RESULT] SUCCESS")
        return

    # Full descriptions for the surviving channels' discovered videos (Phase 3
    # mines these for affiliate links / S-tags). Best-effort — a failure just
    # leaves recent_video_descriptions empty.
    video_ids = [
        m.get("discovered_video_id")
        for m in channels.values()
        if m.get("discovered_video_id")
    ]
    try:
        descriptions = fetch_video_descriptions(video_ids, api_key)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] videos.list crashed: {exc} — proceeding without full descriptions", file=sys.stderr)
        descriptions = {}

    try:
        inserted = write_channels_to_db(
            sb_url, sb_key, args.job_id, args.keyword, channels, details, descriptions, last_uploads,
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
