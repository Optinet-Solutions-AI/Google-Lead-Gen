"""
Snapchat creator search worker (Phase 1 — single pass, pure HTTP).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'snapchat'. Mirrors kick_search.py's CLI shape
(arg names, [RESULT] marker, output JSON, --dry-run) so the worker dispatch
path stays uniform.

PURE HTTP — no GoLogin, no Selenium, no login wall. A recon probe (2026-06-05,
plain VM IP) confirmed both surfaces return HTTP 200 with all data in a
server-rendered __NEXT_DATA__ JSON blob:
  - DISCOVERY: snapchat.com/explore/{keyword} → anchors to /@{handle}
  - ENRICH:    snapchat.com/@{handle} → __NEXT_DATA__ (displayName, bio,
               websiteUrl = the bio-link funnel, subscriberCount, snap-star)

Because the profile fetch is cheap HTTP, discovery + enrichment happen in ONE
pass (like the single-pass Facebook engine — no separate Phase-2 job). Phase 3
(runSnapchatCreatorAnalysis, inline in the app) scores + resolves links +
checks Monday.

Captures, per discovered profile, into public.snapchat_creators (username,
profile_url, discovered_from_keyword, display_name, bio, bio_link,
subscriber_count, is_snap_star) and the websiteUrl into public.snapchat_links
(source 'bio_link').

  exit 1 — env vars missing / bad args
  exit 2 — Snapchat fetch failure (discovery page unreachable)
  exit 3 — Supabase write failure
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any
from urllib.parse import quote

import requests

SNAP_BASE = "https://www.snapchat.com"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
SNAP_TIMEOUT_S = int(os.environ.get("SNAP_HTTP_TIMEOUT_SECONDS", "20"))
SNAP_PROFILE_DELAY_S = float(os.environ.get("SNAP_PROFILE_DELAY_SECONDS", "0.5"))

# Snapchat system / non-creator handles to skip when harvesting the explore page.
_SYS_HANDLES = {
    "snapchat", "team.snapchat", "snap", "snapchatsupport", "snapads",
}

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)
_HANDLE_RE = re.compile(r"/@([A-Za-z0-9._-]{2,40})")


def _fetch(url: str) -> str | None:
    """GET a Snapchat page, return the HTML body or None on failure."""
    try:
        r = requests.get(
            url,
            headers={"user-agent": UA, "accept": "text/html,application/xhtml+xml"},
            timeout=SNAP_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] fetch failed {url}: {exc}", file=sys.stderr)
        return None
    if r.status_code != 200:
        print(f"[WARN] {url} HTTP {r.status_code}", file=sys.stderr)
        return None
    return r.text


def _next_data(html: str) -> dict[str, Any] | None:
    """Parse the __NEXT_DATA__ JSON blob out of a Snapchat page."""
    m = _NEXT_DATA_RE.search(html or "")
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:  # noqa: BLE001
        return None


def _collect_fields(obj: Any, targets: set[str], out: dict[str, Any]) -> None:
    """Walk a parsed JSON tree, recording the first scalar value seen for each
    key in `targets`. Robust to Snapchat's nested __NEXT_DATA__ shape changing."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in targets and k not in out and isinstance(v, (str, int, float, bool)):
                out[k] = v
            _collect_fields(v, targets, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_fields(v, targets, out)


def discover_handles(keyword: str, max_results: int) -> list[str]:
    """Harvest unique creator handles from the explore page for `keyword`."""
    html = _fetch(f"{SNAP_BASE}/explore/{quote(keyword)}")
    if not html:
        return []
    seen: dict[str, str] = {}
    for m in _HANDLE_RE.finditer(html):
        h = m.group(1)
        key = h.lower()
        if key in _SYS_HANDLES or key in seen:
            continue
        seen[key] = h
        if len(seen) >= max_results:
            break
    return list(seen.values())


def enrich_profile(username: str) -> dict[str, Any] | None:
    """Fetch snapchat.com/@{username} and pull the profile fields from
    __NEXT_DATA__. Returns None if the page/JSON couldn't be read."""
    html = _fetch(f"{SNAP_BASE}/@{quote(username)}")
    if not html:
        return None
    data = _next_data(html)
    if not data:
        return None
    fields: dict[str, Any] = {}
    _collect_fields(
        data,
        {"displayName", "bio", "websiteUrl", "subscriberCount", "snapcodeImageUrl", "isOfficial", "badge", "userId"},
        fields,
    )
    sub = fields.get("subscriberCount")
    try:
        sub_int = int(str(sub)) if sub is not None and str(sub).isdigit() else None
    except Exception:  # noqa: BLE001
        sub_int = None
    website = (fields.get("websiteUrl") or "").strip()
    if website and not re.match(r"^https?://", website, re.I):
        website = "https://" + website
    return {
        "user_id": fields.get("userId"),
        "display_name": fields.get("displayName"),
        "bio": (fields.get("bio") or None),
        "bio_link": website or None,
        "subscriber_count": sub_int,
        # A Snap Star / official badge — best-effort across shape variants.
        "is_snap_star": bool(fields.get("isOfficial") or fields.get("badge")),
    }


def _build_rows(
    job_id: str, keyword: str, creators: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], str | None]]:
    """Shape enriched creators into (snapchat_creators row, bio_link) tuples."""
    out: list[tuple[dict[str, Any], str | None]] = []
    for c in creators:
        uname = (c.get("username") or "").strip()
        if not uname:
            continue
        row = {
            "scrape_queue_id": job_id,
            "user_id": c.get("user_id"),
            "username": uname,
            "profile_url": f"{SNAP_BASE}/@{uname}",
            "discovered_from_keyword": keyword,
            "display_name": c.get("display_name"),
            "bio": c.get("bio"),
            "bio_link": c.get("bio_link"),
            "subscriber_count": c.get("subscriber_count"),
            "is_snap_star": c.get("is_snap_star"),
        }
        out.append((row, c.get("bio_link")))
    return out


def write_creators_to_db(sb, job_id: str, keyword: str, creators: list[dict[str, Any]]) -> int:
    payloads = _build_rows(job_id, keyword, creators)
    if not payloads:
        return 0
    rows = [r for r, _ in payloads]
    res = sb.table("snapchat_creators").insert(rows).execute()
    inserted = res.data or []

    link_rows: list[dict[str, Any]] = []
    for (_, bio_link), ret in zip(payloads, inserted):
        cid = ret.get("id")
        if cid and bio_link:
            link_rows.append({"snapchat_creator_id": cid, "url": bio_link, "source": "bio_link"})
    if link_rows:
        sb.table("snapchat_links").insert(link_rows).execute()
    return len(rows)


def _write_summary(output_path: str, keyword: str, language: str, total: int) -> None:
    summary = {
        "params": {"keyword": keyword, "language": language},
        "total_results": total,
        "organic_results": total,
        "ppc_results": 0,
        "pages_scraped": 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": None,
        "results": [],   # creators live in snapchat_creators, not this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Snapchat creator search → snapchat_creators (Phase 1, pure HTTP)")
    parser.add_argument("-k", "--keyword", required=True)
    parser.add_argument("-c", "--country", default="", help="Country display name (unused; logged only)")
    parser.add_argument("--country-code", default="", help="ISO-2 country code (unused for Snapchat)")
    parser.add_argument("--language", default="en", help="2-letter language code (logged only)")
    parser.add_argument("--max-results", type=int, default=100, help="Max creators to fetch (default 100)")
    parser.add_argument("--job-id", required=True, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", default="", help="Worker identifier (logged only)")
    parser.add_argument("--output", required=True, help="Path to write the summary JSON")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch + parse but skip the Supabase insert (prints sample rows)")
    args = parser.parse_args()

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not args.dry_run and (not sb_url or not sb_key):
        print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    language = (args.language or "en").strip().lower() or "en"
    print(f"[INFO] Snapchat search | keyword={args.keyword!r} maxResults={args.max_results} job={args.job_id[:8]}")

    handles = discover_handles(args.keyword, args.max_results)
    if not handles:
        print("[WARN] explore page returned no creator handles (unreachable or empty)")
        # Distinguish a genuinely-empty result from an unreachable page: if the
        # explore fetch itself failed, that's a hard error worth a retry.
        if _fetch(f"{SNAP_BASE}/explore/{quote(args.keyword)}") is None:
            print("[RESULT] FAILED")
            sys.exit(2)
        _write_summary(args.output, args.keyword, language, 0)
        print("[DONE] Snapchat | Total: 0 creators")
        print("[RESULT] SUCCESS")
        return

    print(f"[INFO] discovered {len(handles)} handle(s) — enriching profiles")

    creators: list[dict[str, Any]] = []
    for h in handles:
        prof = enrich_profile(h)
        if prof is None:
            print(f"[WARN] {h}: profile fetch/parse failed — keeping discovery-only row", file=sys.stderr)
            prof = {}
        prof["username"] = h
        creators.append(prof)
        time.sleep(SNAP_PROFILE_DELAY_S)

    if args.dry_run:
        rows = [r for r, _ in _build_rows(args.job_id, args.keyword, creators)]
        print(f"[DRY-RUN] would insert {len(rows)} rows into snapchat_creators.")
        if rows:
            print(json.dumps(rows[0], indent=2, default=str))
        _write_summary(args.output, args.keyword, language, len(rows))
        print(f"[DONE] Snapchat | Total: {len(rows)} creators (dry-run, no DB write)")
        print("[RESULT] SUCCESS")
        return

    from supabase import create_client
    sb = create_client(sb_url, sb_key)
    try:
        inserted = write_creators_to_db(sb, args.job_id, args.keyword, creators)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Supabase insert into snapchat_creators failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(3)

    _write_summary(args.output, args.keyword, language, inserted)
    print(f"[DONE] Snapchat | Total: {inserted} creators inserted into snapchat_creators")
    print("[RESULT] SUCCESS")


if __name__ == "__main__":
    main()
