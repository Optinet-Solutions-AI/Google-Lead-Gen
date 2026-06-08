"""
Telegram channel search worker (Phase 1 — single pass).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'telegram'. Mirrors snapchat_search.py's CLI shape
(arg names, [RESULT] marker, output JSON, --dry-run).

TWO discovery paths, AUTO-SELECTED at runtime:

  • MTProto (preferred) — used when TELEGRAM_API_ID / TELEGRAM_API_HASH /
    TELEGRAM_SESSION are set (a headless Telethon StringSession from
    gen_telegram_session.py). contacts.Search resolves a keyword to public
    channels; GetFullChannel + recent messages enrich them. Highest yield.

  • t.me/s seeded-snowball (NO-AUTH FALLBACK) — used when those env vars are
    absent. There's no pure-HTTP keyword search for Telegram, so we seed from
    a built-in set of gambling channels and crawl outward through the @mentions
    in their posts (casino channels cross-promote heavily), enriching each via
    the public t.me/s/{handle} SEO preview (title, description, subscribers,
    posted links). No login, no verification code — a stopgap until the MTProto
    session is in place, at which point the engine auto-upgrades.

Either way it's a single pass (discover + enrich), no GoLogin/Selenium/browser.
Phase 3 (runTelegramChannelAnalysis, inline) scores + resolves links + Monday.

  exit 1 — env vars missing / bad args
  exit 2 — discovery/auth failure
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
from html import unescape
from typing import Any
from urllib.parse import quote

import requests

TME_BASE = "https://t.me"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
TG_TIMEOUT_S = int(os.environ.get("TG_HTTP_TIMEOUT_SECONDS", "20"))
TG_FETCH_DELAY_S = float(os.environ.get("TG_FETCH_DELAY_SECONDS", "0.4"))
TG_MSG_LIMIT = int(os.environ.get("TG_MSG_LIMIT", "30"))
TG_SNOWBALL_SEEDS = int(os.environ.get("TG_SNOWBALL_SEEDS", "15"))
TG_PER_CHANNEL_DELAY_S = float(os.environ.get("TG_PER_CHANNEL_DELAY_SECONDS", "0.6"))

# Built-in gambling seed channels for the no-auth t.me/s fallback (catalogs +
# affiliate channels that tend to have public previews and cross-link heavily).
# Ones without a public preview self-skip; the snowball does the real work.
# Env-overridable so seeds can be refreshed without a redeploy.
TG_SEEDS = [
    s.strip() for s in os.environ.get(
        "TG_FALLBACK_SEEDS",
        "casinoslot2,casino_affiliates,gamblingcasino1,crypto_gambling123,"
        "casinogramonline,bestcasinobonuses,slotsonline,freespinscasino,"
        "cryptocasinos,gamblingaffiliates",
    ).split(",") if s.strip()
]

_URL_RE = re.compile(r'https?://[^\s"\'<>)]+', re.I)
_MENTION_RE = re.compile(r'(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{4,32})')
_HANDLE_RE = re.compile(r'(?:t\.me/|@)([A-Za-z0-9_]{4,32})')
_OG_TITLE_RE = re.compile(r'<meta property="og:title" content="([^"]*)"')
_OG_DESC_RE = re.compile(r'<meta property="og:description" content="([^"]*)"')
_MSG_RE = re.compile(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.DOTALL)
_SYS_HOST_RE = re.compile(
    r"(^|\.)(t\.me|telegram\.(org|me|dog)|telegram-cdn\.org|tgwidget\.com|"
    r"cdn-telegram\.org|google\.com|gstatic\.com|w3\.org)$", re.I,
)
_SKIP_HANDLES = {"share", "telegram", "telegramtips", "durov", "joinchat", "addstickers", "s", "iv", "proxy"}


def _host(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""


def _links_from_text(text: str) -> list[str]:
    out, seen = [], set()
    for m in _URL_RE.findall(text or ""):
        u = m.rstrip('.,);"\'')
        h = _host(u)
        if not h or _SYS_HOST_RE.search(h) or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def _mentions_from_text(text: str, self_handle: str, pattern: re.Pattern[str]) -> list[str]:
    out, seen = [], set()
    for m in pattern.finditer(text or ""):
        h = m.group(1)
        key = h.lower()
        if key == self_handle.lower() or key in _SKIP_HANDLES or key.endswith("bot") or key in seen:
            continue
        seen.add(key)
        out.append(h)
    return out


# ---------------------------------------------------------------------------
# Path A — t.me/s seeded-snowball (NO AUTH)
# ---------------------------------------------------------------------------

def _fetch(url: str) -> str | None:
    try:
        r = requests.get(url, headers={"user-agent": UA, "accept": "text/html"}, timeout=TG_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] fetch failed {url}: {exc}", file=sys.stderr)
        return None
    if r.status_code != 200:
        return None
    return r.text


def _parse_count(raw: str) -> int | None:
    m = re.search(r"([\d][\d\s.,]*)\s*([KMB])?", raw, re.I)
    if not m:
        return None
    num = m.group(1).replace(" ", "").replace(",", "")
    try:
        val = float(num)
    except ValueError:
        return None
    return int(val * {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get((m.group(2) or "").upper(), 1))


def enrich_tme(handle: str, surface: str) -> dict[str, Any] | None:
    """Enrich a channel from its public t.me/s/{handle} preview. Returns None if
    the handle has no public preview (the 'Telegram: Contact @x' fallback)."""
    html = _fetch(f"{TME_BASE}/s/{quote(handle)}")
    if not html:
        return None
    title_m = _OG_TITLE_RE.search(html)
    title = unescape(title_m.group(1)) if title_m else None
    # No public channel preview → Telegram serves a generic contact page.
    if not title or title.startswith("Telegram: Contact"):
        return None
    desc_m = _OG_DESC_RE.search(html)
    desc = unescape(desc_m.group(1)) if desc_m else None
    sub_m = re.search(r"([\d][\d\s.,]*[KMB]?)\s*subscribers", html, re.I)
    # The t.me/s SEO HTML entity-encodes ampersands, so a posted link like
    # casino.com/?ref=AB123&btag=xyz arrives as ...&amp;btag=xyz. Unescape
    # before link extraction or the stored URL keeps '&amp;', which breaks
    # query-param parsing (the s_tag after the first '&' is lost) and points
    # the UI chip at a dead URL. The MTProto path gets already-decoded text.
    posts = unescape(" ".join(_MSG_RE.findall(html)))

    links, seen = [], set()
    for u in _links_from_text(desc or ""):
        if u not in seen:
            seen.add(u); links.append({"url": u, "source": "description"})
    for u in _links_from_text(posts):
        if u not in seen:
            seen.add(u); links.append({"url": u, "source": "post"})
    mentions = _mentions_from_text(posts, handle, _HANDLE_RE)

    return {
        "username": handle, "surface": surface, "title": title,
        "description": desc, "subscriber_count": _parse_count(sub_m.group(1)) if sub_m else None,
        "links": links, "mentions": mentions,
    }


def collect_tme_snowball(keyword: str, max_results: int) -> list[dict[str, Any]]:
    """No-auth discovery: enrich the built-in gambling seeds, then snowball
    through @mentions (two hops) until max_results. Keyword is recorded for the
    scorer; discovery is seed-driven since Telegram has no pure-HTTP search."""
    out: list[dict[str, Any]] = []
    enriched: set[str] = set()
    frontier: list[str] = list(TG_SEEDS)
    next_frontier: list[str] = []
    hops = 0

    while frontier and len(out) < max_results and hops < 3:
        for handle in frontier:
            if len(out) >= max_results:
                break
            key = handle.lower()
            if key in enriched:
                continue
            enriched.add(key)
            info = enrich_tme(handle, "search" if hops == 0 else "snowball")
            time.sleep(TG_FETCH_DELAY_S)
            if info is None:
                continue
            out.append(info)
            next_frontier.extend(info.get("mentions") or [])
        frontier, next_frontier = next_frontier, []
        hops += 1
    return out


# ---------------------------------------------------------------------------
# Path B — MTProto / Telethon (preferred, when creds present)
# ---------------------------------------------------------------------------

async def _enrich_mtproto(client, entity, surface: str) -> dict[str, Any] | None:
    from telethon import functions
    from telethon.errors import FloodWaitError

    username = getattr(entity, "username", None)
    if not username:
        return None
    title = getattr(entity, "title", None)
    about, subs = None, None
    try:
        full = await client(functions.channels.GetFullChannelRequest(channel=entity))
        about = getattr(full.full_chat, "about", None) or None
        subs = getattr(full.full_chat, "participants_count", None)
    except FloodWaitError as exc:
        print(f"[WARN] flood wait {exc.seconds}s GetFullChannel @{username}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] GetFullChannel @{username} failed: {exc}", file=sys.stderr)

    links, seen, mentions = [], set(), []
    for u in _links_from_text(about or ""):
        if u not in seen:
            seen.add(u); links.append({"url": u, "source": "description"})
    try:
        async for msg in client.iter_messages(entity, limit=TG_MSG_LIMIT):
            txt = msg.message or ""
            if not txt:
                continue
            for u in _links_from_text(txt):
                if u not in seen:
                    seen.add(u); links.append({"url": u, "source": "post"})
            mentions.extend(_mentions_from_text(txt, username, _MENTION_RE))
    except FloodWaitError as exc:
        print(f"[WARN] flood wait {exc.seconds}s messages @{username}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] iter_messages @{username} failed: {exc}", file=sys.stderr)

    seen_m: set[str] = set()
    uniq = [m for m in mentions if not (m.lower() in seen_m or seen_m.add(m.lower()))]
    return {
        "username": username, "surface": surface, "title": title, "description": about,
        "subscriber_count": int(subs) if isinstance(subs, int) else None,
        "links": links, "mentions": uniq,
    }


async def collect_mtproto(client, keyword: str, max_results: int) -> list[dict[str, Any]]:
    from telethon import functions
    from telethon.tl.types import Channel
    try:
        found = await client(functions.contacts.SearchRequest(q=keyword, limit=min(max_results, 50)))
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] contacts.Search failed: {exc}", file=sys.stderr)
        return []
    seeds, seen_ids = [], set()
    for chat in found.chats:
        if isinstance(chat, Channel) and getattr(chat, "broadcast", False) and getattr(chat, "username", None):
            if chat.id not in seen_ids:
                seen_ids.add(chat.id); seeds.append(chat)

    out: list[dict[str, Any]] = []
    enriched: set[str] = set()
    pool: list[str] = []

    async def process(entity, surface: str) -> None:
        uname = (getattr(entity, "username", "") or "").lower()
        if not uname or uname in enriched or len(out) >= max_results:
            return
        enriched.add(uname)
        info = await _enrich_mtproto(client, entity, surface)
        await asyncio.sleep(TG_PER_CHANNEL_DELAY_S)
        if info is None:
            return
        out.append(info)
        if len(enriched) <= TG_SNOWBALL_SEEDS:
            pool.extend(info.get("mentions") or [])

    for ent in seeds:
        if len(out) >= max_results:
            break
        await process(ent, "search")
    for handle in pool:
        if len(out) >= max_results:
            break
        if handle.lower() in enriched:
            continue
        try:
            ent = await client.get_entity(handle)
        except Exception:  # noqa: BLE001
            continue
        from telethon.tl.types import Channel as _Ch
        if isinstance(ent, _Ch) and getattr(ent, "broadcast", False):
            await process(ent, "snowball")
    return out


async def _run_mtproto(keyword: str, max_results: int) -> list[dict[str, Any]]:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    client = TelegramClient(
        StringSession(os.environ["TELEGRAM_SESSION"]),
        int(os.environ["TELEGRAM_API_ID"]), os.environ["TELEGRAM_API_HASH"],
    )
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise RuntimeError("Telegram session not authorized — regenerate with gen_telegram_session.py")
    try:
        return await collect_mtproto(client, keyword, max_results)
    finally:
        await client.disconnect()


# ---------------------------------------------------------------------------
# Supabase + summary (shared)
# ---------------------------------------------------------------------------

def _build_rows(job_id, keyword, channels):
    out = []
    for c in channels:
        uname = (c.get("username") or "").strip()
        if not uname:
            continue
        out.append(({
            "scrape_queue_id": job_id, "username": uname,
            "channel_url": f"{TME_BASE}/{uname}", "discovered_from_keyword": keyword,
            "discovered_from_surface": c.get("surface"), "title": c.get("title"),
            "description": c.get("description"), "subscriber_count": c.get("subscriber_count"),
        }, c.get("links") or []))
    return out


def write_channels_to_db(sb, job_id, keyword, channels) -> int:
    payloads = _build_rows(job_id, keyword, channels)
    if not payloads:
        return 0
    rows = [r for r, _ in payloads]
    res = sb.table("telegram_channels").insert(rows).execute()
    inserted = res.data or []
    link_rows = []
    for (_, links), ret in zip(payloads, inserted):
        cid = ret.get("id")
        if not cid:
            continue
        for l in links[:30]:
            link_rows.append({"telegram_channel_id": cid, "url": l["url"], "source": l["source"]})
    if link_rows:
        sb.table("telegram_links").insert(link_rows).execute()
    return len(rows)


def _write_summary(output_path, keyword, language, total, mode):
    summary = {
        "params": {"keyword": keyword, "language": language, "discovery_mode": mode},
        "total_results": total, "organic_results": total, "ppc_results": 0,
        "pages_scraped": 1, "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": mode == "mtproto", "results": [],
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Telegram channel search → telegram_channels (Phase 1)")
    parser.add_argument("-k", "--keyword", required=True)
    parser.add_argument("-c", "--country", default="")
    parser.add_argument("--country-code", default="")
    parser.add_argument("--language", default="en")
    parser.add_argument("--max-results", type=int, default=100)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--worker-id", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    use_mtproto = all(os.environ.get(k) for k in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION"))
    mode = "mtproto" if use_mtproto else "tme_snowball"
    print(f"[INFO] Telegram search | keyword={args.keyword!r} max={args.max_results} mode={mode} job={args.job_id[:8]}")

    sb = None
    if not args.dry_run:
        sb_url, sb_key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not sb_url or not sb_key:
            print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
            print("[RESULT] FAILED"); sys.exit(1)
        from supabase import create_client
        sb = create_client(sb_url, sb_key)

    try:
        if use_mtproto:
            channels = asyncio.run(_run_mtproto(args.keyword, args.max_results))
        else:
            channels = collect_tme_snowball(args.keyword, args.max_results)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] discovery failed ({mode}): {exc}", file=sys.stderr)
        print("[RESULT] FAILED"); sys.exit(2)

    n_search = sum(1 for c in channels if c.get("surface") == "search")
    n_snow = sum(1 for c in channels if c.get("surface") == "snowball")
    print(f"[INFO] collected {len(channels)} channels (seed/search={n_search}, snowball={n_snow})")

    language = (args.language or "en").strip().lower() or "en"
    if args.dry_run:
        rows = [r for r, _ in _build_rows(args.job_id, args.keyword, channels)]
        print(f"[DRY-RUN] would insert {len(rows)} rows into telegram_channels.")
        if rows:
            print(json.dumps(rows[0], indent=2, default=str))
        _write_summary(args.output, args.keyword, language, len(rows), mode)
        print(f"[DONE] Telegram | Total: {len(rows)} channels (dry-run, no DB write)")
        print("[RESULT] SUCCESS"); return

    try:
        inserted = write_channels_to_db(sb, args.job_id, args.keyword, channels)
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Supabase insert into telegram_channels failed: {exc}", file=sys.stderr)
        print("[RESULT] FAILED"); sys.exit(3)

    _write_summary(args.output, args.keyword, language, inserted, mode)
    print(f"[DONE] Telegram | Total: {inserted} channels inserted into telegram_channels")
    print("[RESULT] SUCCESS")


if __name__ == "__main__":
    main()
