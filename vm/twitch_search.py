"""
Twitch affiliate-streamer search worker (single pass, pure HTTP).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'twitch'. Mirrors kick_search.py /
snapchat_search.py's CLI shape (arg names, [RESULT] marker, output JSON,
--dry-run) so the worker dispatch path stays uniform.

PURE HTTP — no GoLogin, no Selenium, no login wall. Two surfaces:

  1. Helix REST (official API, App Access Token via client_credentials):
       DISCOVERY: /helix/search/channels?query={kw}  → broadcasters
       ENRICH:    /helix/users?id=...                → bio, avatar, created_at
                  /helix/videos?user_id=...&type=archive → VOD title+description
                  /helix/clips?broadcaster_id=...    → clip titles
  2. gql.twitch.tv GraphQL (undocumented public web Client-Id, no auth):
       ENRICH:    user.panels → About-panel links (linkURL + markdown).
                  This is where casino affiliates actually put their funnels,
                  so it's the highest-signal link source. Best-effort: any
                  failure flips panels_fetch_failed and the run still SUCCEEDs.

Because every fetch is cheap HTTP, discovery + enrichment happen in ONE pass
(like the single-pass Snapchat/Facebook engines — no separate Phase-2 job).
Phase 3 (runTwitchStreamerAnalysis, inline in the app) scores + resolves links
+ checks Monday.

Writes, per discovered broadcaster, into public.twitch_streamers and one row
per extracted URL into public.twitch_links (source panel / vod_description /
clip_description / bio / stream_title).

Helix app-token limitations (by design — NOT bugs):
  - follower_count + total_view_count are NOT obtainable with an app token
    (Twitch locked /channels/followers behind a broadcaster/mod token in 2023;
    /users.view_count was removed in 2022). Both columns stay NULL.

  exit 1 — env vars missing / bad args
  exit 2 — Twitch Helix failure (auth, or search unreachable)
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

import requests

# supabase-py is imported lazily inside the DB write so --dry-run works on
# environments without it installed (e.g. Jose's laptop).

TWITCH_AUTH_BASE = "https://id.twitch.tv"
TWITCH_API_BASE  = "https://api.twitch.tv/helix"
TWITCH_GQL_URL   = "https://gql.twitch.tv/gql"
# Twitch's public web client-id — the same value the twitch.tv front-end sends
# for unauthenticated GraphQL. Lets us read public About-panel data with no
# login. Overridable in case Twitch rotates it.
TWITCH_GQL_CLIENT_ID = os.environ.get(
    "TWITCH_GQL_CLIENT_ID", "kimne78kx3ncx6brgo4mv6wki5h1ko"
)

HTTP_TIMEOUT_S      = int(os.environ.get("TWITCH_HTTP_TIMEOUT_SECONDS", "20"))
ENRICH_DELAY_S      = float(os.environ.get("TWITCH_ENRICH_DELAY_SECONDS", "0.1"))
# Per-broadcaster enrichment caps — enough description text to mine links
# without blowing the Helix rate budget on a 100-streamer run.
VIDEOS_PER_CHANNEL  = int(os.environ.get("TWITCH_VIDEOS_PER_CHANNEL", "10"))
CLIPS_PER_CHANNEL   = int(os.environ.get("TWITCH_CLIPS_PER_CHANNEL", "10"))

# Bare URL matcher for description/title/panel text. Trailing punctuation that
# is almost always sentence/markdown noise is trimmed by _clean_url.
_URL_RE = re.compile(r"https?://[^\s<>\"')\]}]+", re.I)


def _clean_url(u: str) -> str:
    return u.rstrip(".,;:!?)\"'»>").strip()


def extract_urls(text: str | None) -> list[str]:
    """Pull http(s) URLs out of free text (VOD/clip/stream title, bio, panel)."""
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for m in _URL_RE.finditer(text):
        u = _clean_url(m.group(0))
        if u and u.lower() not in seen:
            seen.add(u.lower())
            out.append(u)
    return out


def normalize_lang_code(raw: str | None) -> str:
    """Helix reports broadcaster_language as an ISO-639-1 code ('en','pt') or
    occasionally a locale ('en-gb'). Normalize to a lowercase 2-letter code;
    '' for untagged so the filter treats unknown as keep-by-default."""
    if not raw:
        return ""
    v = raw.strip().lower()
    if not v:
        return ""
    if "-" in v:
        v = v.split("-", 1)[0].strip()
    return v[:2] if len(v) >= 2 else ""


def filter_by_language(
    streamers: list[dict[str, Any]], keep_codes: set[str]
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Exclude streamers tagged with a language outside keep_codes; keep
    untagged. Mirrors kick_search.filter_by_language (filter-OUT, not -IN) —
    keyed off the country's gologin_profiles.languages. Returns (kept,
    dropped_by_code) for logging."""
    if not keep_codes:
        return streamers, {}
    kept: list[dict[str, Any]] = []
    dropped: dict[str, int] = {}
    for s in streamers:
        code = normalize_lang_code(s.get("broadcaster_language"))
        if code == "" or code in keep_codes:
            kept.append(s)
        else:
            dropped[code] = dropped.get(code, 0) + 1
    return kept, dropped


# ---------------------------------------------------------------------------
# Helix REST
# ---------------------------------------------------------------------------

def fetch_app_token(client_id: str, client_secret: str) -> str:
    """Client Credentials grant — returns a ~60-day App Access Token."""
    r = requests.post(
        f"{TWITCH_AUTH_BASE}/oauth2/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        },
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"oauth2/token HTTP {r.status_code}: {r.text[:500]}")
    token = (r.json() or {}).get("access_token")
    if not token:
        raise RuntimeError("oauth2/token returned no access_token")
    return token


def _helix_get(path: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """GET a Helix endpoint with one 429-backoff retry. Raises on hard failure."""
    for attempt in range(2):
        r = requests.get(
            f"{TWITCH_API_BASE}/{path}", params=params, headers=headers, timeout=HTTP_TIMEOUT_S
        )
        if r.status_code == 429 and attempt == 0:
            reset = r.headers.get("Ratelimit-Reset")
            wait = 2.0
            try:
                if reset:
                    wait = max(0.5, min(10.0, float(reset) - time.time()))
            except Exception:  # noqa: BLE001
                pass
            print(f"[WARN] Helix /{path} rate-limited — sleeping {wait:.1f}s", file=sys.stderr)
            time.sleep(wait)
            continue
        if r.status_code != 200:
            raise RuntimeError(f"/{path} HTTP {r.status_code}: {r.text[:300]}")
        return r.json() or {}
    raise RuntimeError(f"/{path} still rate-limited after retry")


def search_channels(
    keyword: str, headers: dict[str, str], max_results: int
) -> list[dict[str, Any]]:
    """Paginate /search/channels?query=KW. Returns raw channel objects
    (id, broadcaster_login, display_name, broadcaster_language, game_name,
    title, is_live, tags, thumbnail_url, started_at)."""
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    seen: set[str] = set()
    while len(out) < max_results:
        params: dict[str, Any] = {"query": keyword, "first": min(100, max_results - len(out))}
        if cursor:
            params["after"] = cursor
        body = _helix_get("search/channels", params, headers)
        batch = body.get("data") or []
        if not batch:
            break
        for c in batch:
            bid = c.get("id")
            if not bid or bid in seen:
                continue
            seen.add(bid)
            out.append(c)
            if len(out) >= max_results:
                break
        cursor = (body.get("pagination") or {}).get("cursor") or None
        if not cursor:
            break
    return out


def get_users(ids: list[str], headers: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Batch /users?id=... (≤100 per call). Returns {broadcaster_id: user}."""
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(ids), 100):
        chunk = ids[i : i + 100]
        body = _helix_get("users", [("id", x) for x in chunk], headers)  # type: ignore[arg-type]
        for u in body.get("data") or []:
            if u.get("id"):
                out[u["id"]] = u
    return out


def get_video_descriptions(user_id: str, headers: dict[str, str]) -> list[str]:
    """Recent archived VOD titles + descriptions for link mining."""
    try:
        body = _helix_get(
            "videos",
            {"user_id": user_id, "first": VIDEOS_PER_CHANNEL, "type": "archive"},
            headers,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] /videos user_id={user_id}: {exc}", file=sys.stderr)
        return []
    texts: list[str] = []
    for v in body.get("data") or []:
        parts = [p for p in (v.get("title"), v.get("description")) if p]
        if parts:
            texts.append(" — ".join(parts))
    return texts


def get_clip_titles(broadcaster_id: str, headers: dict[str, str]) -> list[str]:
    """Recent clip titles (Helix clips carry no description, only a title)."""
    try:
        body = _helix_get(
            "clips", {"broadcaster_id": broadcaster_id, "first": CLIPS_PER_CHANNEL}, headers
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] /clips broadcaster_id={broadcaster_id}: {exc}", file=sys.stderr)
        return []
    return [c["title"] for c in (body.get("data") or []) if c.get("title")]


# ---------------------------------------------------------------------------
# gql.twitch.tv — About panels (best-effort, public web client-id)
# ---------------------------------------------------------------------------

_PANELS_QUERY = (
    "query ChannelPanels($login: String!) {"
    " user(login: $login) { id panels {"
    " __typename ... on DefaultPanel { id title description linkURL imageURL } } } }"
)


def fetch_panels(login: str) -> tuple[list[dict[str, Any]], bool]:
    """Fetch a channel's About panels via gql.twitch.tv. Returns
    (panels, failed). panels is a list of {title, description, linkURL}.
    Any error → ([], True) so the caller can flag panels_fetch_failed and
    carry on (the Helix path still produced a usable row)."""
    try:
        r = requests.post(
            TWITCH_GQL_URL,
            headers={"Client-Id": TWITCH_GQL_CLIENT_ID, "Content-Type": "application/json"},
            json={
                "operationName": "ChannelPanels",
                "query": _PANELS_QUERY,
                "variables": {"login": login},
            },
            timeout=HTTP_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] gql panels {login}: {exc}", file=sys.stderr)
        return [], True
    if r.status_code != 200:
        print(f"[WARN] gql panels {login} HTTP {r.status_code}", file=sys.stderr)
        return [], True
    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        return [], True
    if isinstance(body, dict) and body.get("errors"):
        return [], True
    user = ((body or {}).get("data") or {}).get("user") or {}
    panels = user.get("panels")
    if panels is None:
        return [], True
    out: list[dict[str, Any]] = []
    for p in panels:
        if not isinstance(p, dict):
            continue
        out.append({
            "title": p.get("title"),
            "description": p.get("description"),
            "linkURL": p.get("linkURL"),
        })
    return out, False


# ---------------------------------------------------------------------------
# Row shaping + DB write
# ---------------------------------------------------------------------------

def _build_payloads(
    job_id: str, keyword: str, streamers: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Shape enriched streamers into (twitch_streamers row, [link dicts]) tuples.
    Split out so --dry-run can run without supabase-py. Link dicts omit the
    streamer FK (filled post-insert from the returned ids)."""
    out: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for s in streamers:
        login = s.get("broadcaster_login") or s.get("login")
        if not login:
            continue
        stream_title = s.get("title")
        bio = s.get("description")
        vods: list[str] = s.get("_vod_texts") or []
        clips: list[str] = s.get("_clip_titles") or []
        panels: list[dict[str, Any]] = s.get("_panels") or []

        row = {
            "scrape_queue_id": job_id,
            "broadcaster_id": s.get("id"),
            "broadcaster_login": login,
            "display_name": s.get("display_name"),
            "broadcaster_url": f"https://www.twitch.tv/{login}",
            "profile_image_url": s.get("profile_image_url"),
            "broadcaster_language": s.get("broadcaster_language"),
            "account_created_at": s.get("created_at"),
            "discovered_from_keyword": keyword,
            "is_live": s.get("is_live"),
            "game_name": s.get("game_name"),
            "stream_title": stream_title,
            "tags": s.get("tags"),
            # follower_count / total_view_count unavailable with an app token.
            "follower_count": None,
            "total_view_count": None,
            "recent_vod_descriptions": vods or None,
            "recent_clip_descriptions": clips or None,
            "bio": bio,
            "panels_scraped_at": s.get("_panels_scraped_at"),
            "panels_fetch_failed": bool(s.get("_panels_failed")),
        }

        links: list[dict[str, Any]] = []
        seen: set[str] = set()

        def _add(url: str, source: str, **extra: Any) -> None:
            u = _clean_url(url)
            key = (u.lower(), source)
            if not u or key in seen:
                return
            seen.add(key)
            links.append({"url": u, "source": source, **extra})

        for u in extract_urls(stream_title):
            _add(u, "stream_title")
        for u in extract_urls(bio):
            _add(u, "bio")
        for t in vods:
            for u in extract_urls(t):
                _add(u, "vod_description")
        for t in clips:
            for u in extract_urls(t):
                _add(u, "clip_description")
        for p in panels:
            if p.get("linkURL"):
                _add(p["linkURL"], "panel", panel_title=p.get("title"),
                     panel_description=p.get("description"))
            for u in extract_urls(p.get("description")):
                _add(u, "panel", panel_title=p.get("title"),
                     panel_description=p.get("description"))

        out.append((row, links))
    return out


def write_streamers_to_db(
    sb_url: str, sb_key: str, job_id: str, keyword: str, streamers: list[dict[str, Any]]
) -> int:
    """Insert twitch_streamers, then twitch_links keyed to the returned ids.
    Returns streamer rows inserted. Mirrors snapchat_search.write_creators_to_db."""
    payloads = _build_payloads(job_id, keyword, streamers)
    if not payloads:
        return 0
    from supabase import create_client
    sb = create_client(sb_url, sb_key)
    rows = [r for r, _ in payloads]
    res = sb.table("twitch_streamers").insert(rows).execute()
    inserted = res.data or []

    link_rows: list[dict[str, Any]] = []
    for (_, links), ret in zip(payloads, inserted):
        sid = ret.get("id")
        if not sid:
            continue
        for l in links:
            link_rows.append({"twitch_streamer_id": sid, **l})
    # twitch_links may exceed PostgREST's payload comfort zone on a big run —
    # chunk the insert.
    for i in range(0, len(link_rows), 500):
        sb.table("twitch_links").insert(link_rows[i : i + 500]).execute()
    return len(rows)


def _write_summary(
    output_path: str, keyword: str, language: str, total: int, link_total: int
) -> None:
    summary = {
        "params": {"keyword": keyword, "language": language},
        "total_results": total,
        "organic_results": total,
        "ppc_results": 0,
        "pages_scraped": 1,
        "links_captured": link_total,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": None,
        "results": [],   # streamers live in twitch_streamers, not this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Twitch affiliate-streamer search → twitch_streamers (single pass, pure HTTP)"
    )
    parser.add_argument("-k", "--keyword", required=True)
    parser.add_argument("-c", "--country", default="", help="Country display name (unused; logged only)")
    parser.add_argument("--country-code", default="", help="ISO-2 country code (unused for Twitch)")
    parser.add_argument("--language", default="en", help="2-letter language code (logged only)")
    parser.add_argument(
        "--keep-languages",
        default="",
        help="Comma-separated ISO-639-1 codes to KEEP (the country's allowed "
             "languages, e.g. 'en' for AU). Broadcasters tagged with any other "
             "language are filtered OUT; untagged are kept. Empty disables it.",
    )
    parser.add_argument("--max-results", type=int, default=100, help="Max broadcasters to fetch (default 100)")
    parser.add_argument("--job-id", required=True, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", default="", help="Worker identifier (logged only)")
    parser.add_argument("--output", required=True, help="Path to write the summary JSON")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run all API calls but skip the Supabase insert (prints sample rows)")
    args = parser.parse_args()

    client_id = os.environ.get("TWITCH_CLIENT_ID")
    client_secret = os.environ.get("TWITCH_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("[ERROR] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set", file=sys.stderr)
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
        f"[INFO] Twitch search | keyword={args.keyword!r} lang={language} "
        f"maxResults={args.max_results} job={args.job_id[:8]}"
    )

    # 1. App Access Token (Client Credentials grant)
    try:
        token = fetch_app_token(client_id, client_secret)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Twitch OAuth failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(2)
    headers = {"Client-Id": client_id, "Authorization": f"Bearer {token}", "Accept": "application/json"}

    # 2. Discovery — keyword → channels
    try:
        channels = search_channels(args.keyword, headers, args.max_results)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Twitch /search/channels failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(2)

    if not channels:
        print(f"[WARN] No Twitch channels matched keyword {args.keyword!r}")
        _write_summary(args.output, args.keyword, language, 0, 0)
        print("[DONE] TWITCH | Total: 0 streamers (no matching channels)")
        print("[RESULT] SUCCESS")
        return

    # 2b. Language filter (keep untagged; drop off-target tagged)
    keep_codes = {c for c in args.keep_languages.lower().replace(" ", "").split(",") if c}
    if keep_codes:
        before = len(channels)
        channels, dropped = filter_by_language(channels, keep_codes)
        if dropped:
            breakdown = ", ".join(f"{k}={v}" for k, v in sorted(dropped.items()))
            print(f"[INFO] Language filter (keep={sorted(keep_codes)}): kept "
                  f"{len(channels)}/{before}, dropped {before - len(channels)} [{breakdown}]")
        else:
            print(f"[INFO] Language filter (keep={sorted(keep_codes)}): kept all {before}")

    if not channels:
        print("[WARN] All channels filtered out by language", file=sys.stderr)
        _write_summary(args.output, args.keyword, language, 0, 0)
        print("[DONE] TWITCH | Total: 0 (all filtered by language)")
        print("[RESULT] SUCCESS")
        return

    print(f"[INFO] Discovered {len(channels)} channels — enriching (users / videos / clips / panels)")

    # 3. Enrich: batch /users, then per-channel videos + clips + panels
    ids = [c["id"] for c in channels if c.get("id")]
    try:
        users = get_users(ids, headers)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] /users batch failed ({exc}) — continuing without bio/avatar", file=sys.stderr)
        users = {}

    panels_ok = 0
    for c in channels:
        bid = c.get("id")
        login = c.get("broadcaster_login")
        u = users.get(bid or "", {})
        c["profile_image_url"] = u.get("profile_image_url")
        c["created_at"] = u.get("created_at")
        c["description"] = u.get("description")
        c["_vod_texts"] = get_video_descriptions(bid, headers) if bid else []
        c["_clip_titles"] = get_clip_titles(bid, headers) if bid else []
        if login:
            panels, failed = fetch_panels(login)
            c["_panels"] = panels
            c["_panels_failed"] = failed
            c["_panels_scraped_at"] = None if failed else time.strftime("%Y-%m-%dT%H:%M:%SZ")
            if not failed:
                panels_ok += 1
        time.sleep(ENRICH_DELAY_S)
    print(f"[INFO] Panels fetched for {panels_ok}/{len(channels)} channels")

    link_total = sum(len(links) for _, links in _build_payloads(args.job_id, args.keyword, channels))

    # 4. DB write (skipped in --dry-run)
    if args.dry_run:
        payloads = _build_payloads(args.job_id, args.keyword, channels)
        print(f"[DRY-RUN] Would insert {len(payloads)} rows into twitch_streamers "
              f"+ {link_total} into twitch_links.")
        if payloads:
            row, links = payloads[0]
            print("[DRY-RUN] Sample streamer row:")
            print(json.dumps(row, indent=2, default=str))
            print(f"[DRY-RUN] Sample links ({len(links)}): {json.dumps(links[:5], default=str)}")
        _write_summary(args.output, args.keyword, language, len(payloads), link_total)
        print(f"[DONE] TWITCH | Total: {len(payloads)} streamers (dry-run, no DB write)")
        print("[RESULT] SUCCESS")
        return

    try:
        inserted = write_streamers_to_db(sb_url, sb_key, args.job_id, args.keyword, channels)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Supabase insert into twitch_streamers failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(3)

    _write_summary(args.output, args.keyword, language, inserted, link_total)
    print(f"[DONE] TWITCH | Total: {inserted} streamers inserted into twitch_streamers "
          f"({link_total} links)")
    print("[RESULT] SUCCESS")


if __name__ == "__main__":
    main()
