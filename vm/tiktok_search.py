"""
TikTok creator search worker (Phase 1).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'tiktok' that DON'T carry a parent_scrape_job_id.

Modelled on vm/x_search.py (the proven browser-path template) with one
deliberate difference: NO LOGIN WALL. A recon probe (2026-06-05) confirmed
TikTok serves the hashtag (tiktok.com/tag/{kw}) and user-search
(tiktok.com/search/user?q={kw}) surfaces logged-out through the AU resi proxy —
no login wall, no captcha. So unlike x_search.py there is no ensure_logged_in()
gate, no burner account, no is_*_logged_in flag; we run logged-out through the
GoLogin/Selenium session (for the resi proxy + fingerprint) and only fall back
to the captcha-solver checkpoint if TikTok throws an interstitial.

Discovery surfaces (both harvested, results merged):
  - HASHTAG: tiktok.com/tag/{keyword-no-spaces} — broad organic creators
  - SEARCH:  tiktok.com/search/user?q={keyword} — name-matched accounts
Handles come from the rendered DOM (anchors to /@{handle}); the per-creator
bio, bio link, followers etc. are filled by Phase 2 (tiktok_profile_scrape.py),
which renders each tiktok.com/@{handle} and reads its
__UNIVERSAL_DATA_FOR_REHYDRATION__ JSON.

Captures, per discovered account, into public.tiktok_creators:
  - username (the @handle without @), profile_url (tiktok.com/@{username})
  - discovered_from_keyword, discovered_from_surface ('hashtag' | 'search')

Reuses vm/scraper.py's GoLogin/Selenium plumbing by import (co-located in ~/
on the VM, so `import scraper` resolves to ~/scraper.py). scraper.py's main()
is __main__-guarded, so importing it has no side effects.

CLI mirrors x_search.py's contract (profile_id positional, --port, the
[RESULT] marker, a summary JSON to --output) so worker.py's dispatch path
stays uniform.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed
  exit 3 — Supabase write failure

A separate --mode probe (does not touch the DB) runs the search for an
explicit --query and dumps the parsed handles to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from urllib.parse import quote
from typing import Any

# scraper.py (and its gologin/selenium imports) is only importable on the VM.
# Import lazily in main() so `--help` works anywhere.

TT_BASE = "https://www.tiktok.com"

# Failure mitigation / pacing. All env-tunable so we can dial reliability vs
# speed without a redeploy.
TT_MAX_TRIES = int(os.environ.get("TT_PHASE1_MAX_TRIES", "3"))
TT_BLOCK_COOLDOWN_S = int(os.environ.get("TT_PHASE1_BLOCK_COOLDOWN_SECONDS", "12"))
# Scroll budget per surface for the infinite results grid + settle delay.
TT_SCROLL_MAX_CYCLES = int(os.environ.get("TT_PHASE1_SCROLL_CYCLES", "20"))
TT_SCROLL_DELAY_S = int(os.environ.get("TT_PHASE1_SCROLL_DELAY_SECONDS", "3"))


# ---------------------------------------------------------------------------
# Handle extraction
# ---------------------------------------------------------------------------

# Harvest every creator handle on the page from anchors to /@{handle}. TikTok's
# CSS class names are build-generated, but the /@{handle} profile-link href is
# durable across the hashtag + search surfaces (confirmed by the recon probe).
_HANDLE_JS = r"""
const out = [];
const seen = new Set();
for (const a of document.querySelectorAll('a[href^="/@"], a[href*="tiktok.com/@"]')) {
  const href = a.getAttribute('href') || a.href || '';
  const m = href.match(/\/@([A-Za-z0-9._]{1,40})(?:[/?]|$)/);
  if (!m) continue;
  const uname = m[1];
  const key = uname.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ username: uname });
}
return out;
"""


def collect_handles(driver, max_results: int) -> list[str]:
    """Scroll the results surface, accumulating unique creator handles until we
    hit max_results or the list stops growing (two stale cycles)."""
    by_username: dict[str, str] = {}   # lowercase key -> original-case handle
    stale_cycles = 0
    for cycle in range(TT_SCROLL_MAX_CYCLES):
        try:
            batch = driver.execute_script(_HANDLE_JS) or []
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] handle extraction crashed (cycle {cycle}): {exc}", file=sys.stderr)
            batch = []

        before = len(by_username)
        for u in batch:
            uname = (u.get("username") or "").strip()
            if uname:
                by_username.setdefault(uname.lower(), uname)
        gained = len(by_username) - before

        if len(by_username) >= max_results:
            break
        if gained == 0:
            stale_cycles += 1
            if stale_cycles >= 2:
                break
        else:
            stale_cycles = 0

        try:
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:  # noqa: BLE001
            pass
        time.sleep(TT_SCROLL_DELAY_S)

    return list(by_username.values())[:max_results]


def _hashtag_token(keyword: str) -> str:
    """TikTok hashtags are concatenated (no spaces/punctuation):
    'online casino' -> 'onlinecasino'."""
    return re.sub(r"[^A-Za-z0-9]", "", keyword)


def _harvest_surface(driver, url: str, surface: str, found: dict[str, dict[str, Any]],
                     max_results: int, *, retry: bool = False) -> int:
    """Navigate `url`, scroll-collect creator handles, fold new ones into
    `found` tagged with `surface` (first surface wins on dupes). Returns how
    many NEW handles this surface added. Best-effort — never raises. When
    `retry` is set and the first pass finds nothing (TikTok intermittently
    gates a surface behind a login wall logged-out), it reloads once."""
    before = len(found)
    for attempt in range(2 if retry else 1):
        try:
            driver.get(url)
            time.sleep(5)
            handles = collect_handles(driver, max_results)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] {surface} surface failed: {exc}", file=sys.stderr)
            handles = []
        for uname in handles:
            found.setdefault(uname.lower(), {"username": uname, "surface": surface})
        if handles or not retry:
            break
        print(f"[INFO] {surface} surface returned 0 (likely gated) — retrying once", file=sys.stderr)
        time.sleep(TT_BLOCK_COOLDOWN_S)
    gained = len(found) - before
    print(f"[INFO] {surface} surface: +{gained} creator(s)")
    return gained


def search_creators(driver, keyword: str, max_results: int) -> list[dict[str, Any]]:
    """Harvest creator handles from three surfaces, merging (first surface wins
    on dupes). TikTok caps/gates each surface differently logged-out, so we
    sweep all three for coverage:
      - hashtag    tiktok.com/tag/{tag}        — broad organic posters (gated
                   intermittently → one retry)
      - search     tiktok.com/search/user?q=   — accounts name-matching the kw
      - content    tiktok.com/search?q=        — creators POSTING about the kw
                   (the best affiliate candidates; not just name matches)
    """
    found: dict[str, dict[str, Any]] = {}

    tag = _hashtag_token(keyword)
    if tag:
        _harvest_surface(driver, f"{TT_BASE}/tag/{quote(tag)}", "hashtag", found, max_results, retry=True)

    if len(found) < max_results:
        _harvest_surface(driver, f"{TT_BASE}/search/user?q={quote(keyword)}", "search", found, max_results)

    if len(found) < max_results:
        _harvest_surface(driver, f"{TT_BASE}/search?q={quote(keyword)}", "content", found, max_results)

    return list(found.values())[:max_results]


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def _build_rows(job_id: str, keyword: str, creators: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Shape parsed handles into tiktok_creators row dicts. Split out so
    --dry-run can call it without supabase-py installed."""
    rows: list[dict[str, Any]] = []
    for c in creators:
        uname = (c.get("username") or "").strip()
        if not uname:
            continue
        rows.append({
            "scrape_queue_id": job_id,
            "username": uname,
            "profile_url": f"{TT_BASE}/@{uname}",
            "discovered_from_keyword": keyword,
            "discovered_from_surface": c.get("surface"),
        })
    return rows


def write_creators_to_db(sb, job_id: str, keyword: str, creators: list[dict[str, Any]]) -> int:
    rows = _build_rows(job_id, keyword, creators)
    if not rows:
        return 0
    sb.table("tiktok_creators").insert(rows).execute()
    return len(rows)


def _write_summary(output_path: str, keyword: str, language: str, total: int) -> None:
    """Summary JSON for worker.py → complete_scrape_job. Shape mirrors
    x_search.py / kick_search.py so the dispatch path stays uniform."""
    summary = {
        "params": {"keyword": keyword, "language": language},
        "total_results": total,
        "organic_results": total,
        "ppc_results": 0,
        "pages_scraped": 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": False,  # TikTok Phase 1 runs logged-out
        "results": [],          # creators live in tiktok_creators, not this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


# ---------------------------------------------------------------------------
# GoLogin lifecycle (mirrors x_search.py: defensive stop, bring-up retry loop,
# teardown on every exit path). No login gate — TikTok serves logged-out.
# ---------------------------------------------------------------------------

def run(args, scraper_mod) -> int:
    from gologin import GoLogin

    gologin_token = os.environ.get("GOLOGIN_API_TOKEN")
    if not gologin_token:
        print("[ERROR] GOLOGIN_API_TOKEN is not set", file=sys.stderr)
        return 1

    sb = None
    if args.mode == "search" and not args.dry_run:
        sb_url = os.environ.get("SUPABASE_URL")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not sb_url or not sb_key:
            print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
            return 1
        from supabase import create_client
        sb = create_client(sb_url, sb_key)

    keyword = args.query if args.mode == "probe" else args.keyword

    gl = GoLogin({"token": gologin_token, "profile_id": args.profile_id, "port": args.port})
    try:
        gl.stop()
    except Exception:
        pass
    time.sleep(3)

    driver = None
    session_ok = False
    for attempt in range(1, TT_MAX_TRIES + 1):
        try:
            print(f"[INFO] GoLogin session bring-up (attempt {attempt}/{TT_MAX_TRIES})")
            debugger_address = gl.start()
            time.sleep(2)
            driver = scraper_mod.connect_to_gologin_browser(debugger_address)
            scraper_mod._install_turnstile_interceptor(driver)
            if not scraper_mod.check_browser_connectivity(driver):
                raise RuntimeError("Browser connectivity check failed — proxy may be unreachable")
            session_ok = True
            break
        except scraper_mod.InteractiveCancelException:
            print("[INFO] operator cancelled at Captcha solver checkpoint")
            _teardown(driver, gl)
            print("[RESULT] FAILED")
            return 1
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] session bring-up attempt {attempt} failed: {exc}", file=sys.stderr)
            _teardown(driver, gl)
            driver = None
            if attempt < TT_MAX_TRIES:
                time.sleep(TT_BLOCK_COOLDOWN_S)

    if not session_ok or driver is None:
        print("[ERROR] could not bring up a GoLogin session after retries", file=sys.stderr)
        try:
            gl.stop()
        except Exception:
            pass
        print("[RESULT] FAILED")
        return 2

    try:
        print(f"[INFO] TikTok search | keyword={keyword!r} maxResults={args.max_results}")
        creators = search_creators(driver, keyword, args.max_results)
        print(f"[INFO] parsed {len(creators)} unique creator handle(s)")

        if args.mode == "probe":
            print("\n===== PROBE tiktok_search =====")
            print(json.dumps(creators, indent=2, default=str)[:8000])
            print("===== END PROBE =====\n")
            print("[RESULT] SUCCESS")
            return 0

        if args.dry_run:
            rows = _build_rows(args.job_id, keyword, creators)
            print(f"[DRY-RUN] would insert {len(rows)} rows into tiktok_creators.")
            if rows:
                print(json.dumps(rows[0], indent=2, default=str))
            _write_summary(args.output, keyword, args.language, len(rows))
            print(f"[DONE] TikTok | Total: {len(rows)} creators (dry-run, no DB write)")
            print("[RESULT] SUCCESS")
            return 0

        try:
            inserted = write_creators_to_db(sb, args.job_id, keyword, creators)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] Supabase insert into tiktok_creators failed: {exc}", file=sys.stderr)
            print("[RESULT] FAILED")
            return 3

        _write_summary(args.output, keyword, args.language, inserted)
        print(f"[DONE] TikTok | Total: {inserted} creators inserted into tiktok_creators")
        print("[RESULT] SUCCESS")
        return 0
    finally:
        _teardown(driver, gl)


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


def main() -> None:
    parser = argparse.ArgumentParser(description="TikTok creator search → tiktok_creators (Phase 1)")
    parser.add_argument("profile_id", help="GoLogin profile ID (resi proxy; no login needed)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["search", "probe"], default="search",
                        help="'search' (default) writes tiktok_creators; 'probe' dumps parsed handles for --query, no DB")
    parser.add_argument("-k", "--keyword", default="", help="Keyword to search TikTok for")
    parser.add_argument("--query", default=None, help="(probe mode) keyword to search")
    parser.add_argument("-c", "--country", default="", help="Country display name (logged only)")
    parser.add_argument("--country-code", dest="country_code", default="", help="ISO-2 country code (logged only)")
    parser.add_argument("--language", default="en", help="2-letter language code (Phase 1: logged only)")
    parser.add_argument("--max-results", type=int, default=100, help="Max creators to collect (default 100)")
    parser.add_argument("--job-id", dest="job_id", default=None, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--output", default="/tmp/tiktok_search.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Park on noVNC if TikTok throws a checkpoint instead of failing")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the browser + parse but skip all DB writes")
    args = parser.parse_args()

    if args.mode == "probe" and not args.query:
        print("[ERROR] --mode probe requires --query", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)
    if args.mode == "search" and not args.keyword:
        print("[ERROR] --keyword is required in search mode", file=sys.stderr)
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
    # x_search.py / fb_adlibrary_search.py main()).
    scraper_mod._CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    scraper_mod._CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)
    scraper_mod._CAPTCHA_SOLVER_CTX["country_code"] = (args.country_code or "").strip().upper() or None

    rc = run(args, scraper_mod)
    sys.exit(rc)


if __name__ == "__main__":
    main()
