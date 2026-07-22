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
                  /helix/videos?user_id=...&type=all → VOD/highlight title+desc
                                                        + newest publish date
                  /helix/clips?broadcaster_id=...    → clip titles + newest date
  2. gql.twitch.tv GraphQL (undocumented public web Client-Id, no auth):
       ENRICH:    user.panels → About-panel links (linkURL + markdown).
                  This is where casino affiliates actually put their funnels,
                  so it's the highest-signal link source. Best-effort: any
                  failure flips panels_fetch_failed and the run still SUCCEEDs.

Because every fetch is cheap HTTP, discovery + enrichment happen in ONE pass
(like the single-pass Snapchat/Facebook engines — no separate Phase-2 job).
Phase 3 (runTwitchStreamerAnalysis, inline in the app) scores + resolves links
+ checks Monday.

Two quality gates run before the DB write (added 2026-06-26 from Andrei's
feedback):
  - RECENCY: a last_activity_at is derived (newest VOD/highlight, newest clip,
    or live-now) and channels whose known last activity predates
    TWITCH_MAX_INACTIVE_DAYS (default 365) are dropped — killing the dead
    2–8yr-old channels that dominated 'casino'/'slots' results.
  - CONTACTS: email / Telegram / Discord are mined out of the bio, panels and
    descriptions (the old code only captured http(s) URLs, so bare emails and
    "Telegram: @handle" copy were silently lost).

Writes, per discovered broadcaster, into public.twitch_streamers and one row
per extracted URL into public.twitch_links (source panel / vod_description /
clip_description / bio / stream_title).

Helix app-token limitations (by design — NOT bugs):
  - total_view_count was removed by Twitch in 2022 — permanently unavailable.
    Column stays NULL.
  - follower_count via Helix requires a broadcaster/mod token, BUT the public
    web GraphQL endpoint (`gql.twitch.tv` + unauth client-id) exposes
    `user.followers.totalCount`. We fetch it there — see fetch_channel_info().

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
# Recency gate. /search/channels returns long-dead channels (Andrei's
# 2026-06-26 report: ~80% of 'casino'/'slots' hits last streamed 2–8 years
# ago). We compute a last_activity_at from the freshest signal available with
# an app token (newest VOD/highlight, newest clip, or live-now) and DROP any
# channel whose KNOWN last activity is older than this cutoff. Channels with no
# activity signal at all are kept (last_activity_at stays NULL) so we don't
# silently lose a streamer who simply has VOD storage off. 0 disables the gate.
INACTIVE_CUTOFF_DAYS = int(os.environ.get("TWITCH_MAX_INACTIVE_DAYS", "365"))
# Minimum follower_count needed to keep a channel with no other activity
# signal (no VOD/clip/live). Default 0 = keep everything the Helix search
# returned; let the UI prioritize by follower_count instead of dropping.
# Raise this via env if operators start complaining about "empty shell"
# noise again — a brand-new empty account has 0 followers, so does a
# permanently-dormant one; the trade-off is that 0 might legitimately mean
# "new affiliate account not yet built up".
NO_SIGNAL_FOLLOWER_MIN = int(os.environ.get("TWITCH_NO_SIGNAL_FOLLOWER_MIN", "0"))
# Video type for the /videos enrich call. "all" (archives + highlights +
# uploads) gives both a better last-content date (highlights/uploads persist
# after the ~14–60d archive auto-expiry) and more link-mining text than the
# old archive-only call.
VIDEO_TYPE = os.environ.get("TWITCH_VIDEO_TYPE", "all")

# Bare URL matcher for description/title/panel text. Trailing punctuation that
# is almost always sentence/markdown noise is trimmed by _clean_url.
_URL_RE = re.compile(r"https?://[^\s<>\"')\]}]+", re.I)

# --- Contact extraction (Andrei 2026-06-26: "contact info is available
# (email, telegram) but the tool doesn't pick it up"). The old code only
# matched http(s) URLs, so bare emails and bare/contextual Telegram + Discord
# handles in a bio/panel were dropped. These mine them out of the same free
# text we already collect.
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# Strings that look like an email but are really a filename / image ref
# (`logo@2x.png`) or a social/at-handle — reject by their "TLD".
_EMAIL_BAD_TLD = {
    "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "css", "js",
    "json", "html", "php", "2x", "3x",
}
# t.me / telegram.me / telegram.dog links, with or without scheme; captures
# the handle (skipping joinchat/+ invite prefixes, which aren't usernames).
_TME_RE = re.compile(
    r"(?:https?://)?(?:t\.me|telegram\.me|telegram\.dog)/(?:joinchat/|\+)?([A-Za-z0-9_]{3,32})\b",
    re.I,
)
# Bare "@handle" only when a Telegram cue sits close before it (so we don't
# grab Twitter/Discord @mentions). [^@\n]{0,25} spans the usual separators —
# ": ", " 👉 ", "channel ", "-" — without crossing a line or a stray @. Covers
# EN + common RU/PT affiliate copy.
_TG_AT_RE = re.compile(
    r"(?:telegram|telega|tg|телеграм|телега)[^@\n]{0,25}@([A-Za-z0-9_]{4,32})\b",
    re.I,
)
_DISCORD_RE = re.compile(
    r"(?:https?://)?discord(?:\.gg|(?:app)?\.com/invite)/([A-Za-z0-9-]{2,32})\b",
    re.I,
)


def extract_contacts(texts: list[str | None]) -> dict[str, str | None]:
    """Mine the first email / Telegram / Discord contact out of a streamer's
    free text (bio, stream title, VOD & clip descriptions, About-panel text).
    Returns {contact_email, telegram_url, discord_url} with NULL where absent.
    First-seen wins; Telegram/Discord handles are normalised to canonical URLs
    so they're click-through in the UI and de-dupe against captured link URLs."""
    email: str | None = None
    telegram: str | None = None
    discord: str | None = None
    for raw in texts:
        if not raw:
            continue
        if email is None:
            for m in _EMAIL_RE.finditer(raw):
                cand = m.group(0)
                tld = cand.rsplit(".", 1)[-1].lower()
                if tld in _EMAIL_BAD_TLD:
                    continue
                email = cand
                break
        if telegram is None:
            m = _TME_RE.search(raw) or _TG_AT_RE.search(raw)
            if m:
                telegram = f"https://t.me/{m.group(1)}"
        if discord is None:
            m = _DISCORD_RE.search(raw)
            if m:
                discord = f"https://discord.gg/{m.group(1)}"
        if email and telegram and discord:
            break
    return {"contact_email": email, "telegram_url": telegram, "discord_url": discord}


def iso_max(a: str | None, b: str | None) -> str | None:
    """Return the later of two ISO-8601 timestamps (lexical compare is correct
    for same-format `...Z` strings). NULLs are ignored."""
    if not a:
        return b
    if not b:
        return a
    return a if a >= b else b


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


def get_videos(user_id: str, headers: dict[str, str]) -> tuple[list[str], str | None]:
    """Recent VOD/highlight titles + descriptions for link mining, plus the
    newest video's publish time (the strongest last-activity signal we can get
    with an app token). Returns (texts, latest_published_at)."""
    try:
        body = _helix_get(
            "videos",
            {"user_id": user_id, "first": VIDEOS_PER_CHANNEL, "type": VIDEO_TYPE},
            headers,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] /videos user_id={user_id}: {exc}", file=sys.stderr)
        return [], None
    texts: list[str] = []
    latest: str | None = None
    for v in body.get("data") or []:
        parts = [p for p in (v.get("title"), v.get("description")) if p]
        if parts:
            texts.append(" — ".join(parts))
        latest = iso_max(latest, v.get("published_at") or v.get("created_at"))
    return texts, latest


def get_clips(broadcaster_id: str, headers: dict[str, str]) -> tuple[list[str], str | None]:
    """Recent clip titles (Helix clips carry no description, only a title),
    plus the newest clip's creation time. Helix sorts clips by views (no time
    sort), so this is the freshest of the channel's top clips — a useful
    secondary recency floor that exposes years-dormant channels."""
    try:
        body = _helix_get(
            "clips", {"broadcaster_id": broadcaster_id, "first": CLIPS_PER_CHANNEL}, headers
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] /clips broadcaster_id={broadcaster_id}: {exc}", file=sys.stderr)
        return [], None
    titles: list[str] = []
    latest: str | None = None
    for c in body.get("data") or []:
        if c.get("title"):
            titles.append(c["title"])
        latest = iso_max(latest, c.get("created_at"))
    return titles, latest


# ---------------------------------------------------------------------------
# gql.twitch.tv — About panels + follower count (best-effort, public web client-id)
# ---------------------------------------------------------------------------

# Combined query: fetches About-panels AND follower count in a single
# round-trip. Twitch's web frontend exposes both under `user` via the
# same unauth client-id — no persisted-query hash required for this shape.
_CHANNEL_INFO_QUERY = (
    "query ChannelInfo($login: String!) {"
    " user(login: $login) {"
    "  id"
    "  followers { totalCount }"
    "  panels {"
    "   __typename ... on DefaultPanel { id title description linkURL imageURL }"
    "  }"
    " }"
    "}"
)


def fetch_channel_info(login: str) -> tuple[list[dict[str, Any]], int | None, bool]:
    """Fetch a channel's About-panels + follower count via gql.twitch.tv in
    a single request. Returns (panels, follower_count, panels_failed).

    - panels: list of {title, description, linkURL} — same shape as before
    - follower_count: int if returned, None on any parse failure (kept
      distinct from panels_failed so a broken followers subquery doesn't
      also invalidate the panel data or vice versa)
    - panels_failed: True on any transport / GraphQL error so the caller
      can still flag panels_fetch_failed and carry on
    """
    try:
        r = requests.post(
            TWITCH_GQL_URL,
            headers={"Client-Id": TWITCH_GQL_CLIENT_ID, "Content-Type": "application/json"},
            json={
                "operationName": "ChannelInfo",
                "query": _CHANNEL_INFO_QUERY,
                "variables": {"login": login},
            },
            timeout=HTTP_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] gql channel-info {login}: {exc}", file=sys.stderr)
        return [], None, True
    if r.status_code != 200:
        print(f"[WARN] gql channel-info {login} HTTP {r.status_code}", file=sys.stderr)
        return [], None, True
    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        return [], None, True
    if isinstance(body, dict) and body.get("errors"):
        return [], None, True
    user = ((body or {}).get("data") or {}).get("user") or {}
    # Follower count — best-effort; missing / non-int leaves it None.
    follower_count: int | None = None
    followers = user.get("followers")
    if isinstance(followers, dict):
        tc = followers.get("totalCount")
        if isinstance(tc, int):
            follower_count = tc
    # Panels — same handling as the old fetch_panels()
    panels_raw = user.get("panels")
    if panels_raw is None:
        return [], follower_count, True
    panels: list[dict[str, Any]] = []
    for p in panels_raw:
        if not isinstance(p, dict):
            continue
        panels.append({
            "title": p.get("title"),
            "description": p.get("description"),
            "linkURL": p.get("linkURL"),
        })
    return panels, follower_count, False


def fetch_panels(login: str) -> tuple[list[dict[str, Any]], bool]:
    """Backwards-compat wrapper around fetch_channel_info() — some call
    sites only need the panel data. Discards the follower_count."""
    panels, _fc, failed = fetch_channel_info(login)
    return panels, failed


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

        # Mine email / Telegram / Discord out of every text surface we have.
        contact_texts: list[str | None] = [bio, stream_title, *vods, *clips]
        for p in panels:
            contact_texts.extend([p.get("title"), p.get("description")])
        contacts = extract_contacts(contact_texts)

        row = {
            "scrape_queue_id": job_id,
            "broadcaster_id": s.get("id"),
            "broadcaster_login": login,
            "display_name": s.get("display_name"),
            "broadcaster_url": f"https://www.twitch.tv/{login}",
            "profile_image_url": s.get("profile_image_url"),
            "broadcaster_language": s.get("broadcaster_language"),
            "account_created_at": s.get("created_at"),
            "last_activity_at": s.get("_last_activity_at"),
            "contact_email": contacts["contact_email"],
            "telegram_url": contacts["telegram_url"],
            "discord_url": contacts["discord_url"],
            "discovered_from_keyword": keyword,
            "is_live": s.get("is_live"),
            "game_name": s.get("game_name"),
            "stream_title": stream_title,
            "tags": s.get("tags"),
            # follower_count comes from the public web GraphQL endpoint (see
            # fetch_channel_info). total_view_count was removed by Twitch in
            # 2022 and stays NULL forever.
            "follower_count": s.get("_follower_count"),
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

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ")
    panels_ok = 0
    for c in channels:
        bid = c.get("id")
        login = c.get("broadcaster_login")
        u = users.get(bid or "", {})
        c["profile_image_url"] = u.get("profile_image_url")
        c["created_at"] = u.get("created_at")
        c["description"] = u.get("description")
        vod_texts, last_vod_at = get_videos(bid, headers) if bid else ([], None)
        clip_titles, last_clip_at = get_clips(bid, headers) if bid else ([], None)
        c["_vod_texts"] = vod_texts
        c["_clip_titles"] = clip_titles
        # last_activity_at: freshest of live-now, newest VOD, newest clip.
        # started_at is the current stream's start (only set while live).
        live_at = (c.get("started_at") or now_iso) if c.get("is_live") else None
        c["_last_activity_at"] = iso_max(iso_max(live_at, last_vod_at), last_clip_at)
        if login:
            panels, follower_count, failed = fetch_channel_info(login)
            c["_panels"] = panels
            c["_panels_failed"] = failed
            c["_panels_scraped_at"] = None if failed else now_iso
            c["_follower_count"] = follower_count
            if not failed:
                panels_ok += 1
        time.sleep(ENRICH_DELAY_S)
    print(f"[INFO] Panels fetched for {panels_ok}/{len(channels)} channels")

    # Recency gate — drop channels whose KNOWN last activity predates the
    # cutoff (Andrei's dead 2-8yr-old channels).
    #
    # Unknown-activity channels (NULL last_activity_at) used to be kept
    # unconditionally to avoid dropping a live streamer whose VODs/clips
    # were disabled — but the trade-off was 80+ empty-shell channels
    # ("online casino"-flavour handles with 0 VODs, 0 clips) making it
    # into every scrape. Now: keep an unknown-activity channel only if
    # its follower_count is >= NO_SIGNAL_FOLLOWER_MIN — that's the
    # cheapest signal that it's an actual channel with an audience,
    # even if it hasn't streamed recently. GraphQL fetch failures leave
    # follower_count as NULL, which we treat the same as "unknown but
    # kept" so a transient network hiccup doesn't lose real data.
    if INACTIVE_CUTOFF_DAYS > 0:
        cutoff_epoch = time.time() - INACTIVE_CUTOFF_DAYS * 86400.0
        kept: list[dict[str, Any]] = []
        dropped_stale = dropped_empty = kept_unknown = 0
        for c in channels:
            la = c.get("_last_activity_at")
            if not la:
                # No activity signal — decide based on follower_count.
                fc = c.get("_follower_count")
                if fc is None:
                    # GraphQL fetch failed OR field missing — err on
                    # the safe side and keep.
                    kept_unknown += 1
                    kept.append(c)
                elif fc >= NO_SIGNAL_FOLLOWER_MIN:
                    kept_unknown += 1
                    kept.append(c)
                else:
                    dropped_empty += 1
                continue
            try:
                la_epoch = time.mktime(time.strptime(la[:19], "%Y-%m-%dT%H:%M:%S"))
            except Exception:  # noqa: BLE001 — unparseable → treat as unknown, keep
                kept.append(c)
                continue
            if la_epoch < cutoff_epoch:
                dropped_stale += 1
            else:
                kept.append(c)
        print(
            f"[INFO] Recency gate (cutoff={INACTIVE_CUTOFF_DAYS}d, "
            f"no-signal-follower-min={NO_SIGNAL_FOLLOWER_MIN}): "
            f"kept {len(kept)}/{len(channels)} — dropped {dropped_stale} stale + "
            f"{dropped_empty} empty-shell, {kept_unknown} kept with unknown activity"
        )
        channels = kept
        if not channels:
            print("[WARN] All channels filtered out by the recency gate", file=sys.stderr)
            _write_summary(args.output, args.keyword, language, 0, 0)
            print(f"[DONE] TWITCH | Total: 0 (all {dropped_stale} matched channels were inactive)")
            print("[RESULT] SUCCESS")
            return

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
