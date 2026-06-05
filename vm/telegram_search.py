"""
Telegram channel search worker (Phase 1 — single pass, MTProto/Telethon).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'telegram'. Mirrors snapchat_search.py's CLI shape
(arg names, [RESULT] marker, output JSON, --dry-run).

DISCOVERY uses Telegram's real API via Telethon (a recon probe showed NO viable
pure-HTTP keyword discovery — lyzem is thin, TGStat/others are Cloudflare-
gated). A headless StringSession (generated once by gen_telegram_session.py)
authenticates a user account; `contacts.Search` resolves a keyword to matching
public channels, and we snowball one hop through @mentions in their recent
messages (casino channels cross-promote heavily). NO GoLogin, NO Selenium, NO
browser — just the MTProto API.

ENRICH (same pass, also via Telethon): per channel, GetFullChannel → title,
about (description), participants_count; iter_messages → recent post text →
the casino affiliate links (telegram_links source 'post') + the description
links (source 'description'). Phase 3 (runTelegramChannelAnalysis, inline)
scores + resolves links + checks Monday.

Env (set in ~/.env on each VM — see gen_telegram_session.py):
  TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

  exit 1 — env vars missing / bad args
  exit 2 — Telegram auth/connection failure
  exit 3 — Supabase write failure
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from typing import Any

TG_MSG_LIMIT = int(os.environ.get("TG_MSG_LIMIT", "30"))          # recent msgs per channel
TG_SNOWBALL_SEEDS = int(os.environ.get("TG_SNOWBALL_SEEDS", "15")) # channels to crawl @mentions from
TG_PER_CHANNEL_DELAY_S = float(os.environ.get("TG_PER_CHANNEL_DELAY_SECONDS", "0.6"))

_URL_RE = re.compile(r'https?://[^\s"\'<>)]+', re.I)
_MENTION_RE = re.compile(r'(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{4,32})')
_SYS_HOST_RE = re.compile(
    r"(^|\.)(t\.me|telegram\.(org|me|dog)|telegram-cdn\.org)$", re.I,
)
_SKIP_HANDLES = {"share", "telegram", "telegramtips", "durov", "joinchat", "addstickers"}


def _host(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""


def _links_from_text(text: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for m in _URL_RE.findall(text or ""):
        u = m.rstrip('.,);')
        h = _host(u)
        if not h or _SYS_HOST_RE.search(h) or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def _mentions_from_text(text: str, self_handle: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for m in _MENTION_RE.finditer(text or ""):
        h = m.group(1)
        key = h.lower()
        if key == self_handle.lower() or key in _SKIP_HANDLES or key.endswith("bot") or key in seen:
            continue
        seen.add(key)
        out.append(h)
    return out


async def _enrich(client, entity, surface: str) -> dict[str, Any] | None:
    """GetFullChannel + recent messages → channel dict, or None on failure."""
    from telethon import functions
    from telethon.errors import FloodWaitError

    username = getattr(entity, "username", None)
    if not username:
        return None  # only public (username'd) channels are useful/linkable

    title = getattr(entity, "title", None)
    about = None
    subs = None
    try:
        full = await client(functions.channels.GetFullChannelRequest(channel=entity))
        about = getattr(full.full_chat, "about", None) or None
        subs = getattr(full.full_chat, "participants_count", None)
    except FloodWaitError as exc:
        print(f"[WARN] flood wait {exc.seconds}s on GetFullChannel @{username} — skipping detail", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] GetFullChannel @{username} failed: {exc}", file=sys.stderr)

    links: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    mentions: list[str] = []
    for u in _links_from_text(about or ""):
        if u not in seen_urls:
            seen_urls.add(u)
            links.append({"url": u, "source": "description"})
    try:
        async for msg in client.iter_messages(entity, limit=TG_MSG_LIMIT):
            txt = msg.message or ""
            if not txt:
                continue
            for u in _links_from_text(txt):
                if u not in seen_urls:
                    seen_urls.add(u)
                    links.append({"url": u, "source": "post"})
            mentions.extend(_mentions_from_text(txt, username))
    except FloodWaitError as exc:
        print(f"[WARN] flood wait {exc.seconds}s reading @{username} messages", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] iter_messages @{username} failed: {exc}", file=sys.stderr)

    # dedupe mentions preserving order
    seen_m: set[str] = set()
    uniq_mentions = [m for m in mentions if not (m.lower() in seen_m or seen_m.add(m.lower()))]

    return {
        "username": username,
        "surface": surface,
        "title": title,
        "description": about,
        "subscriber_count": int(subs) if isinstance(subs, int) else None,
        "links": links,
        "mentions": uniq_mentions,
    }


async def collect_channels(client, keyword: str, max_results: int) -> list[dict[str, Any]]:
    """contacts.Search for the keyword → channels, enrich each, snowball one hop
    through @mentions of the first TG_SNOWBALL_SEEDS channels."""
    from telethon import functions
    from telethon.tl.types import Channel

    try:
        found = await client(functions.contacts.SearchRequest(q=keyword, limit=min(max_results, 50)))
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] contacts.Search failed: {exc}", file=sys.stderr)
        return []

    # Broadcast channels only (skip megagroups/users); keep order, dedupe by id.
    seeds: list[Any] = []
    seen_ids: set[int] = set()
    for chat in found.chats:
        if isinstance(chat, Channel) and getattr(chat, "broadcast", False) and getattr(chat, "username", None):
            if chat.id not in seen_ids:
                seen_ids.add(chat.id)
                seeds.append(chat)

    out: list[dict[str, Any]] = []
    enriched_handles: set[str] = set()
    snowball_pool: list[str] = []

    async def process(entity, surface: str) -> None:
        uname = (getattr(entity, "username", "") or "").lower()
        if not uname or uname in enriched_handles or len(out) >= max_results:
            return
        enriched_handles.add(uname)
        info = await _enrich(client, entity, surface)
        await asyncio.sleep(TG_PER_CHANNEL_DELAY_S)
        if info is None:
            return
        out.append(info)
        if len(enriched_handles) <= TG_SNOWBALL_SEEDS:
            snowball_pool.extend(info.get("mentions") or [])

    for ent in seeds:
        if len(out) >= max_results:
            break
        await process(ent, "search")

    for handle in snowball_pool:
        if len(out) >= max_results:
            break
        if handle.lower() in enriched_handles:
            continue
        try:
            ent = await client.get_entity(handle)
        except Exception:  # noqa: BLE001
            continue
        from telethon.tl.types import Channel as _Ch
        if isinstance(ent, _Ch) and getattr(ent, "broadcast", False):
            await process(ent, "snowball")

    return out


def _build_rows(
    job_id: str, keyword: str, channels: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], list[dict[str, str]]]]:
    out: list[tuple[dict[str, Any], list[dict[str, str]]]] = []
    for c in channels:
        uname = (c.get("username") or "").strip()
        if not uname:
            continue
        row = {
            "scrape_queue_id": job_id,
            "username": uname,
            "channel_url": f"https://t.me/{uname}",
            "discovered_from_keyword": keyword,
            "discovered_from_surface": c.get("surface"),
            "title": c.get("title"),
            "description": c.get("description"),
            "subscriber_count": c.get("subscriber_count"),
        }
        out.append((row, c.get("links") or []))
    return out


def write_channels_to_db(sb, job_id: str, keyword: str, channels: list[dict[str, Any]]) -> int:
    payloads = _build_rows(job_id, keyword, channels)
    if not payloads:
        return 0
    rows = [r for r, _ in payloads]
    res = sb.table("telegram_channels").insert(rows).execute()
    inserted = res.data or []
    link_rows: list[dict[str, Any]] = []
    for (_, links), ret in zip(payloads, inserted):
        cid = ret.get("id")
        if not cid:
            continue
        for l in links[:30]:
            link_rows.append({"telegram_channel_id": cid, "url": l["url"], "source": l["source"]})
    if link_rows:
        sb.table("telegram_links").insert(link_rows).execute()
    return len(rows)


def _write_summary(output_path: str, keyword: str, language: str, total: int) -> None:
    summary = {
        "params": {"keyword": keyword, "language": language},
        "total_results": total,
        "organic_results": total,
        "ppc_results": 0,
        "pages_scraped": 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": True,
        "results": [],
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


async def run(args) -> int:
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    session = os.environ.get("TELEGRAM_SESSION")
    if not api_id or not api_hash or not session:
        print("[ERROR] TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION not set "
              "(run gen_telegram_session.py once and add them to ~/.env)", file=sys.stderr)
        return 1

    sb = None
    if not args.dry_run:
        sb_url = os.environ.get("SUPABASE_URL")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not sb_url or not sb_key:
            print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
            return 1
        from supabase import create_client
        sb = create_client(sb_url, sb_key)

    client = TelegramClient(StringSession(session), int(api_id), api_hash)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            print("[ERROR] Telegram session is not authorized — regenerate it with gen_telegram_session.py",
                  file=sys.stderr)
            return 2
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Telegram connect failed: {exc}", file=sys.stderr)
        return 2

    try:
        channels = await collect_channels(client, args.keyword, args.max_results)
    finally:
        await client.disconnect()

    n_search = sum(1 for c in channels if c.get("surface") == "search")
    n_snow = sum(1 for c in channels if c.get("surface") == "snowball")
    print(f"[INFO] collected {len(channels)} channels (search={n_search}, snowball={n_snow})")

    language = (args.language or "en").strip().lower() or "en"
    if args.dry_run:
        rows = [r for r, _ in _build_rows(args.job_id, args.keyword, channels)]
        print(f"[DRY-RUN] would insert {len(rows)} rows into telegram_channels.")
        if rows:
            print(json.dumps(rows[0], indent=2, default=str))
        _write_summary(args.output, args.keyword, language, len(rows))
        print(f"[DONE] Telegram | Total: {len(rows)} channels (dry-run, no DB write)")
        return 0

    try:
        inserted = write_channels_to_db(sb, args.job_id, args.keyword, channels)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Supabase insert into telegram_channels failed: {exc}", file=sys.stderr)
        return 3

    _write_summary(args.output, args.keyword, language, inserted)
    print(f"[DONE] Telegram | Total: {inserted} channels inserted into telegram_channels")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Telegram channel search → telegram_channels (Phase 1, MTProto)")
    parser.add_argument("-k", "--keyword", required=True)
    parser.add_argument("-c", "--country", default="", help="Country display name (unused; logged only)")
    parser.add_argument("--country-code", default="", help="ISO-2 country code (unused for Telegram)")
    parser.add_argument("--language", default="en", help="2-letter language code (logged only)")
    parser.add_argument("--max-results", type=int, default=100, help="Max channels to fetch (default 100)")
    parser.add_argument("--job-id", required=True, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", default="", help="Worker identifier (logged only)")
    parser.add_argument("--output", required=True, help="Path to write the summary JSON")
    parser.add_argument("--dry-run", action="store_true",
                        help="Search + enrich but skip the Supabase insert (prints sample rows)")
    args = parser.parse_args()

    print(f"[INFO] Telegram search | keyword={args.keyword!r} maxResults={args.max_results} job={args.job_id[:8]}")
    try:
        rc = asyncio.run(run(args))
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] telegram_search crashed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)
    if rc == 0:
        print("[RESULT] SUCCESS")
    else:
        print("[RESULT] FAILED")
    sys.exit(rc)


if __name__ == "__main__":
    main()
