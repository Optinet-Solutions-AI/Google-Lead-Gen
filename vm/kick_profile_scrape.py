"""
Kick streamer profile enrichment worker (Phase 2).

Called as a subprocess by vm/worker.py for Kick scrape_queue jobs that
carry a parent_scrape_job_id (an operator-triggered ▶ "enrich profiles"
job). Phase 1 (kick_search.py) discovers streamers via the pure-HTTP
api.kick.com path; Phase 2 fills the affiliate-link surfaces that only
exist on the *rendered* kick.com/{slug} page and require a real Chrome
session through GoLogin (kick.com sits behind Cloudflare and 403s raw
HTTP — same wall as the Bing scraper).

Backfills, per streamer, into public.kick_streamers:
  - follower_count
  - {instagram,twitter,facebook,youtube,tiktok}_handle
  - about_scraped_at  (success marker; NULL stays for retry)
  - about_fetch_failed
and inserts public.kick_links rows with source 'promo_card' / 'pinned_chat'.

Scope: the worker selects the top-N streamers of the parent job by
viewer/subscriber count that are not yet enriched (about_scraped_at NULL).
N is passed via --top-n (worker reads KICK_PHASE2_TOP_N, default 25).

Reuses vm/scraper.py's GoLogin/Selenium plumbing by import — the two
files are co-located in ~/ on the VM, so `import scraper` resolves to
~/scraper.py. Specifically: connect_to_gologin_browser,
_install_turnstile_interceptor, attempt_auto_captcha_solve,
request_interactive_checkpoint, the _CAPTCHA_SOLVER_CTX dict and
MAX_RETRIES. scraper.py's main() is __main__-guarded, so importing it
has no side effects.

CLI mirrors kick_search.py's contract (the [RESULT] marker + a summary
JSON to --output) so worker.py's dispatch path stays uniform.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed after retries
  exit 3 — Supabase read/write failure

A separate --probe MODE (does not touch the DB, ignores --parent-job-id)
visits one explicit --slug and dumps the candidate internal-API
responses + page HTML to stdout. Used for the one-time VM spike that
confirms exact field names before the promo-card / pinned-chat parsers
are hardened. kick.com is DNS-blocked on the dev laptop, so every run of
this script — including --dry-run and --probe — must happen on a VM.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from html import unescape
from typing import Any

# scraper.py (and its gologin/selenium imports) is only importable on the
# VM. Import lazily in main() so `--help` works anywhere and the failure
# mode is an explicit message rather than a top-level ImportError.

KICK_BASE = "https://kick.com"

# ---------------------------------------------------------------------------
# Extraction model (confirmed by the VM --probe spike, 2026-06-01):
#
#   - The internal v2 API (kick.com/api/v2/channels/{slug}) 403s even from
#     inside the GoLogin browser, so we parse the *rendered DOM* instead.
#   - The follower count is in the Next.js RSC payload as
#         \"followers_count\":NNNN
#     (escaped quotes — it lives inside a self.__next_f.push JS string).
#   - Socials AND casino promo cards are the same "channel link" widget,
#     rendered as:
#         <h3 ...>TITLE</h3><a href="URL" target="_blank" rel="noreferrer">
#           <img ... src="https://files.kick.com/images/channel-links/.../...">
#     TITLE is the brand/platform label ("Instagram", "Rainbet",
#     "$70,000 Leaderboard"). A title that names one of the five social
#     platforms below fills that *_handle column; everything else is a
#     promo_card (Rainbet/Luxdrop/leaderboards/Discord/own-site, etc.) —
#     exactly the affiliate surfaces Phase 2 exists to capture.
#   - Scoping to the channel-links <img> excludes Kick's own site-chrome
#     social links (instagram.com/kickstreaming, discord.gg/kick).
# ---------------------------------------------------------------------------

# Channel-link title (lower-cased, stripped) → kick_streamers handle column.
_SOCIAL_TITLE_MAP: dict[str, str] = {
    "instagram": "instagram_handle",
    "twitter":   "twitter_handle",
    "x":         "twitter_handle",
    "facebook":  "facebook_handle",
    "youtube":   "youtube_handle",
    "tiktok":    "tiktok_handle",
}

# follower count — optional leading backslash because it's inside the RSC
# JS string literal (\"followers_count\":NNNN).
_FOLLOWERS_RE = re.compile(r'\\?"followers_count\\?"\s*:\s*(\d+)')

# A rendered channel-link card: <h3>TITLE</h3><a href="URL" ... rel="noreferrer">
# <img ... channel-links ...>. Real DOM (unescaped quotes), so plain ".
_CHANNEL_LINK_RE = re.compile(
    r'<h3[^>]*>([^<]{1,120})</h3>\s*<a\s+href="([^"]+)"[^>]*rel="noreferrer"[^>]*>\s*'
    r'<img[^>]+channel-links',
    re.IGNORECASE,
)


def extract_from_page(driver) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Parse follower count + channel-link cards (socials + promo cards)
    from the rendered kick.com/{slug} DOM. Returns (streamer_fields, links).

    Empty results are legitimate (a streamer with no socials/panels) — the
    caller treats a successfully-rendered page as enriched regardless.
    """
    try:
        html = driver.page_source or ""
    except Exception:  # noqa: BLE001
        html = ""

    fields: dict[str, Any] = {}
    m = _FOLLOWERS_RE.search(html)
    if m:
        fields["follower_count"] = int(m.group(1))

    links: list[dict[str, Any]] = []
    for raw_title, raw_url in _CHANNEL_LINK_RE.findall(html):
        title = unescape(raw_title).strip()
        url = unescape(raw_url).strip()
        if not url:
            continue
        col = _SOCIAL_TITLE_MAP.get(title.lower())
        if col:
            # First card for a platform wins; store the full URL (lossless —
            # youtube /@handle, instagram /name/, discord invites all differ).
            fields.setdefault(col, url)
        else:
            links.append({
                "url": url,
                "source": "promo_card",
                "promo_brand": title or None,
                "promo_bonus_terms": None,
            })

    # Pinned chat message — best effort. It typically arrives over the chat
    # websocket rather than in the SSR HTML, so a miss is expected and fine.
    try:
        links.extend(_extract_pinned(driver))
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] pinned-chat extraction crashed: {exc}", file=sys.stderr)

    # Dedupe by (source, url) — the pinned banner often renders in nested
    # DOM nodes, and the same link can appear in multiple cards. Keep the
    # first occurrence (preserves its promo_brand).
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for link in links:
        key = (link["source"], link["url"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(link)

    return fields, deduped


def _extract_pinned(driver) -> list[dict[str, Any]]:
    """Look for a pinned-message banner in the chat DOM and pull any URLs
    out of its text. Returns [] when there's no pinned message."""
    from selenium.webdriver.common.by import By
    links: list[dict[str, Any]] = []
    try:
        els = driver.find_elements(
            By.CSS_SELECTOR,
            '[class*="pinned" i], [data-testid*="pinned" i], [data-test*="pinned" i]',
        )
    except Exception:  # noqa: BLE001
        els = []
    for el in els[:4]:
        try:
            txt = el.text or ""
        except Exception:  # noqa: BLE001
            txt = ""
        for url in _urls_in_text(txt):
            links.append({"url": url, "source": "pinned_chat"})
    return links


def _urls_in_text(text: str) -> list[str]:
    """Extract http(s) URLs from free text. Deduped, order-preserving."""
    seen: set[str] = set()
    out: list[str] = []
    for m in re.findall(r"https?://[^\s)>\"']+", text or ""):
        u = m.rstrip(".,);")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


# ---------------------------------------------------------------------------
# Per-streamer visit
# ---------------------------------------------------------------------------

def enrich_one(driver, scraper_mod, slug: str, *, interactive: bool,
               job_id: str | None, worker_id: str | None, worker_port: int) -> dict[str, Any]:
    """Navigate kick.com/{slug}, clear any Cloudflare wall, extract.

    Returns {"ok": bool, "fields": {...}, "links": [...]}.
    ok=False means the about page couldn't be read (Cloudflare unsolved,
    nav error) — caller marks about_fetch_failed and leaves about_scraped_at
    NULL so a re-run retries.
    """
    url = f"{KICK_BASE}/{slug}"
    # Single attempt per session. Kick's WAF blocks the 2nd+ request from a
    # session ("Request blocked by security policy."), so re-navigating in the
    # same session is pointless — the caller retries with a FRESH session
    # (new proxy IP) instead. ok=False (stub/blocked/nav error) signals that.
    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {slug}: navigation failed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    time.sleep(2)  # let Cloudflare/JS settle

    if _cloudflare_blocked(driver):
        print(f"[INFO] {slug}: Cloudflare challenge — attempting solve")
        solved = False
        try:
            solved = scraper_mod.attempt_auto_captcha_solve(driver)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] {slug}: auto-solve crashed: {exc}", file=sys.stderr)
        if not solved and interactive and job_id:
            try:
                solved = scraper_mod.request_interactive_checkpoint(
                    driver, job_id=job_id, worker_id=worker_id,
                    worker_port=worker_port, reason="kick_cloudflare",
                )
            except scraper_mod.InteractiveCancelException:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"[WARN] {slug}: checkpoint crashed: {exc}", file=sys.stderr)
        if not solved or _cloudflare_blocked(driver):
            print(f"[WARN] {slug}: still blocked by Cloudflare", file=sys.stderr)
            return {"ok": False, "fields": {}, "links": []}

    # Wait for the SPA to hydrate the profile (follower count +
    # channel-link cards render client-side).
    _wait_for_profile(driver)

    try:
        html = driver.page_source or ""
    except Exception:  # noqa: BLE001
        html = ""
    if len(html) < 5000:
        # Stub page — almost always Kick's WAF block on a reused IP.
        # Caller will retry on a fresh session.
        print(f"[WARN] {slug}: page did not render (len={len(html)}) — likely WAF block",
              file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    fields, links = extract_from_page(driver)
    return {"ok": True, "fields": fields, "links": links}


def _wait_for_profile(driver, timeout_s: int = 10) -> None:
    """Poll until the channel-link cards (socials + promo) are in the DOM,
    or the timeout elapses. Best-effort — extraction runs regardless.

    We wait on 'channel-links' specifically, NOT 'followers_count':
    followers_count is in the initial RSC payload and present almost
    immediately, so returning on it skips the wait for the link cards,
    which hydrate a beat later. To avoid stalling the full timeout on a
    streamer who genuinely has no cards, bail early once the page data has
    loaded (followers_count seen) and a short grace period has passed."""
    deadline = time.time() + timeout_s
    data_seen_at: float | None = None
    while time.time() < deadline:
        try:
            html = driver.page_source or ""
        except Exception:  # noqa: BLE001
            html = ""
        if "channel-links" in html:
            return
        if "followers_count" in html:
            if data_seen_at is None:
                data_seen_at = time.time()
            elif time.time() - data_seen_at >= 4:
                return  # data loaded, no cards after grace — likely none
        time.sleep(1)


def _cloudflare_blocked(driver) -> bool:
    """Cloudflare interstitial detector for kick.com.

    NOTE: the page_source substring 'challenge-platform' is NOT a reliable
    signal — Cloudflare's managed-challenge script is referenced on every
    normally-served Kick page, so matching it false-positives (confirmed on
    the 2026-06-01 spike: a fully-rendered profile was wrongly skipped).
    Use the title and window._cf_chl_opt, which is an object only during an
    *active* challenge and null/undefined otherwise."""
    try:
        title = (driver.title or "").lower()
    except Exception:  # noqa: BLE001
        title = ""
    if "just a moment" in title or "attention required" in title:
        return True
    try:
        return bool(driver.execute_script("return !!(window._cf_chl_opt)"))
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def fetch_target_streamers(sb, parent_job_id: str, top_n: int) -> list[dict[str, Any]]:
    """Top-N not-yet-enriched streamers of the parent Phase-1 job,
    ranked by live viewers then subscribers."""
    res = (
        sb.table("kick_streamers")
        .select("id, slug, stream_viewer_count, active_subscribers_count")
        .eq("scrape_queue_id", parent_job_id)
        .is_("about_scraped_at", "null")
        .order("stream_viewer_count", desc=True, nullsfirst=False)
        .order("active_subscribers_count", desc=True, nullsfirst=False)
        .limit(top_n)
        .execute()
    )
    return res.data or []


def write_enrichment(sb, streamer_id: str, fields: dict[str, Any], links: list[dict[str, Any]]) -> None:
    """Update the streamer row (marking about_scraped_at) and insert any
    promo_card / pinned_chat links. Called only on a successful read."""
    update = dict(fields)
    update["about_fetch_failed"] = False
    # supabase-py can't send a raw SQL now() through .update(); a client UTC
    # stamp keeps the write a single round-trip. (The updated_at trigger on
    # kick_streamers still fires server-side.)
    update["about_scraped_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sb.table("kick_streamers").update(update).eq("id", streamer_id).execute()
    if links:
        rows = [{**l, "kick_streamer_id": streamer_id} for l in links]
        sb.table("kick_links").insert(rows).execute()


def mark_failed(sb, streamer_id: str) -> None:
    sb.table("kick_streamers").update({"about_fetch_failed": True}).eq("id", streamer_id).execute()


def _write_summary(output_path: str, parent_job_id: str, attempted: int, enriched: int, failed: int) -> None:
    summary = {
        "params": {"parent_scrape_job_id": parent_job_id},
        "total_results": enriched,
        "organic_results": enriched,
        "ppc_results": 0,
        "pages_scraped": attempted,
        "attempted": attempted,
        "failed": failed,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": None,
        "results": [],
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


# ---------------------------------------------------------------------------
# GoLogin lifecycle (mirrors scraper.py main(): defensive stop, retry loop
# with a fresh start each attempt, teardown on every exit path).
# ---------------------------------------------------------------------------

def run(args, scraper_mod) -> int:
    from gologin import GoLogin

    gologin_token = os.environ.get("GOLOGIN_API_TOKEN")
    if not gologin_token:
        print("[ERROR] GOLOGIN_API_TOKEN is not set", file=sys.stderr)
        return 1

    sb = None
    if not args.dry_run and args.mode == "enrich":
        sb_url = os.environ.get("SUPABASE_URL")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not sb_url or not sb_key:
            print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
            return 1
        from supabase import create_client
        sb = create_client(sb_url, sb_key)

    # Build the work-list up front (probe mode is a single explicit slug).
    if args.mode == "probe":
        targets = [{"id": None, "slug": args.slug}]
    else:
        if not sb:  # dry-run still needs the list; read it if creds present
            sb_url, sb_key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            if sb_url and sb_key:
                from supabase import create_client
                sb = create_client(sb_url, sb_key)
        if not sb:
            print("[ERROR] need Supabase creds to select target streamers", file=sys.stderr)
            return 3
        try:
            targets = fetch_target_streamers(sb, args.parent_job_id, args.top_n)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] selecting target streamers failed: {exc}", file=sys.stderr)
            return 3
        if not targets:
            print("[INFO] no un-enriched streamers for this parent job — nothing to do")
            _write_summary(args.output, args.parent_job_id, 0, 0, 0)
            print("[RESULT] SUCCESS")
            return 0
        print(f"[INFO] enriching {len(targets)} streamer(s) (top-{args.top_n}) "
              f"for parent job {args.parent_job_id[:8]}")

    gl = GoLogin({"token": gologin_token, "profile_id": args.profile_id, "port": args.port})
    try:
        gl.stop()
    except Exception:
        pass
    time.sleep(3)

    attempted = enriched = failed = 0

    # ONE FRESH GoLogin session (new proxy IP) PER streamer. Kick's WAF
    # returns {"error":"Request blocked by security policy."} for the 2nd+
    # request in a session, so a session only ever scrapes one streamer.
    # Each streamer gets up to MAX_RETRIES fresh sessions (covers a transient
    # GoLogin/connectivity hiccup OR an unlucky already-flagged proxy IP).
    for t in targets:
        slug = t["slug"]
        attempted += 1
        result: dict[str, Any] | None = None

        for attempt in range(1, scraper_mod.MAX_RETRIES + 1):
            driver = None
            try:
                print(f"[INFO] {slug}: GoLogin session (attempt {attempt}/{scraper_mod.MAX_RETRIES})")
                debugger_address = gl.start()
                time.sleep(2)
                driver = scraper_mod.connect_to_gologin_browser(debugger_address)
                scraper_mod._install_turnstile_interceptor(driver)
                if not scraper_mod.check_browser_connectivity(driver):
                    raise RuntimeError("Browser connectivity check failed — proxy may be unreachable")

                result = enrich_one(
                    driver, scraper_mod, slug,
                    interactive=args.interactive, job_id=args.job_id,
                    worker_id=args.worker_id, worker_port=args.port,
                )
                if args.mode == "probe":
                    _dump_probe(driver, slug)
                    break
                if result["ok"]:
                    break
                # Stub / WAF block — a fresh session (new IP) may clear it.
                if attempt < scraper_mod.MAX_RETRIES:
                    print(f"[INFO] {slug}: retrying on a fresh session...")
            except scraper_mod.InteractiveCancelException:
                print("[INFO] operator cancelled at Captcha solver checkpoint")
                _teardown(driver, gl)
                print("[RESULT] FAILED")
                return 1
            except Exception as exc:  # noqa: BLE001
                print(f"[ERROR] {slug}: session attempt {attempt} failed: {exc}", file=sys.stderr)
            finally:
                _teardown(driver, gl)
            if attempt < scraper_mod.MAX_RETRIES:
                time.sleep(7)

        if args.mode == "probe":
            continue

        if result is None or not result["ok"]:
            failed += 1
            if not args.dry_run and t["id"] is not None:
                mark_failed(sb, t["id"])
            print(f"[WARN] {slug}: enrichment failed after retries", file=sys.stderr)
        elif args.dry_run:
            enriched += 1
            print(f"[DRY-RUN] {slug}: fields={json.dumps(result['fields'])} "
                  f"links={len(result['links'])}")
        else:
            write_enrichment(sb, t["id"], result["fields"], result["links"])
            enriched += 1
            print(f"[INFO] {slug}: enriched ({len(result['fields'])} fields, "
                  f"{len(result['links'])} links)")

        time.sleep(2)  # brief pause before the next fresh session

    if args.mode == "probe":
        print("[RESULT] SUCCESS")
        return 0

    _write_summary(args.output, args.parent_job_id, attempted, enriched, failed)
    print(f"[DONE] KICK Phase 2 | attempted={attempted} enriched={enriched} failed={failed}")
    print("[RESULT] SUCCESS")
    return 0


def _teardown(driver, gl) -> None:
    if driver is not None:
        try:
            driver.quit()
        except Exception:
            pass
    try:
        gl.stop()
    except Exception:
        pass


def _dump_probe(driver, slug: str) -> None:
    """Spike helper: run the real DOM extraction and print what it found,
    so a future probe can confirm the parser still matches Kick's markup."""
    _wait_for_profile(driver)
    print(f"\n===== PROBE {slug} =====")
    try:
        html = driver.page_source or ""
    except Exception as exc:  # noqa: BLE001
        html = ""
        print(f"(page_source unavailable: {exc})")
    print(f"page_source length = {len(html)}")
    print(f"_cf_chl_opt active  = {_cloudflare_blocked(driver)}")
    fields, links = extract_from_page(driver)
    print("----- extracted streamer fields -----")
    print(json.dumps(fields, indent=2, default=str))
    print(f"----- extracted kick_links ({len(links)}) -----")
    print(json.dumps(links, indent=2, default=str))
    print(f"===== END PROBE {slug} =====\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Kick streamer profile enrichment (Phase 2)")
    parser.add_argument("profile_id", help="GoLogin profile ID (from gologin_profiles for the country)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["enrich", "probe"], default="enrich",
                        help="'enrich' (default) backfills DB; 'probe' dumps API/DOM for one --slug, no DB")
    parser.add_argument("--slug", default=None, help="(probe mode) single kick.com slug to dump")
    parser.add_argument("--parent-job-id", dest="parent_job_id", default=None,
                        help="Phase-1 scrape_queue.id whose streamers to enrich")
    parser.add_argument("--top-n", dest="top_n", type=int, default=25,
                        help="Max streamers to enrich this run (ranked by viewers/subs)")
    parser.add_argument("--job-id", dest="job_id", default=None,
                        help="This Phase-2 scrape_queue.id (for captcha checkpoints)")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--output", default="/tmp/kick_phase2.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Checkpoint to noVNC on an unsolved Cloudflare wall instead of skipping")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the browser + extraction but skip all DB writes (VM only — DNS-blocked locally)")
    args = parser.parse_args()

    if args.mode == "probe" and not args.slug:
        print("[ERROR] --mode probe requires --slug", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)
    if args.mode == "enrich" and not args.parent_job_id:
        print("[ERROR] --parent-job-id is required in enrich mode", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    try:
        import scraper as scraper_mod  # ~/scraper.py on the VM
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] could not import scraper.py (must run on a VM with selenium/gologin): {exc}",
              file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    # Share captcha context with scraper.py's helpers (same mechanism as
    # scraper.py main()): lets attempt_auto_captcha_solve / checkpoints read
    # job/worker context without re-threading every call.
    scraper_mod._CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    scraper_mod._CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)

    rc = run(args, scraper_mod)
    sys.exit(rc)


if __name__ == "__main__":
    main()
