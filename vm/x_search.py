"""
X (x.com / twitter) creator search worker (Phase 1).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'x' that DON'T carry a parent_scrape_job_id.

Unlike kick_search.py / youtube_search.py (which hit real APIs over plain
HTTP), X has no affordable search API for new developers — Basic/Pro are
closed to new accounts and pay-per-use excludes keyword search. So X
Phase 1 is the BROWSER path: an authenticated GoLogin/Selenium session
navigating x.com/search?q={keyword}&f=user (the "People" tab) and parsing
the rendered UserCell results. This is the same shape as the Google/Bing
scraper, NOT the pure-HTTP Kick/YouTube Phase 1 — so worker.py routes 'x'
jobs through the browser/profile path, and this script takes a GoLogin
profile_id + port like kick_profile_scrape.py.

The session must be signed into a (burner) X account: x.com gates
logged-out scraping behind a hard login wall. When the profile isn't
logged in and --interactive is set, we park on the login wall via the
noVNC checkpoint so an operator can sign in once (cookies then persist in
the GoLogin profile). Without --interactive we fail with a clear message.

Captures, per discovered account, into public.x_creators:
  - username (the @handle, stored without @), profile_url (x.com/{username})
  - display_name, bio
  - discovered_from_keyword
Follower counts, socials, pinned tweet, website + affiliate links are
filled by Phase 2 (x_profile_scrape.py), which renders each x.com/{username}.

Reuses vm/scraper.py's GoLogin/Selenium plumbing by import (co-located in
~/ on the VM, so `import scraper` resolves to ~/scraper.py). scraper.py's
main() is __main__-guarded, so importing it has no side effects.

CLI mirrors kick_profile_scrape.py's contract (profile_id positional,
--port, the [RESULT] marker, a summary JSON to --output) so worker.py's
dispatch path stays uniform.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed, or not logged into X
  exit 3 — Supabase write failure

A separate --mode probe (does not touch the DB) runs the search for an
explicit --query and dumps the parsed UserCells to stdout — the one-time
VM spike that confirms the DOM parser matches X's markup before it's
hardened. x.com is fine to reach locally, but probe still needs GoLogin +
an X-logged-in profile, so it runs on a VM.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib.parse import quote
from typing import Any

# scraper.py (and its gologin/selenium imports) is only importable on the
# VM. Import lazily in main() so `--help` works anywhere.

X_BASE = "https://x.com"

# Failure mitigation / pacing. All env-tunable so we can dial reliability
# vs speed without a redeploy.
X_MAX_TRIES = int(os.environ.get("X_PHASE1_MAX_TRIES", "3"))
X_BLOCK_COOLDOWN_S = int(os.environ.get("X_PHASE1_BLOCK_COOLDOWN_SECONDS", "12"))
# How many scroll cycles to attempt while loading the infinite People list,
# and the settle delay between scrolls (jittered-ish via the loop). Keep the
# scroll budget bounded so a sparse keyword doesn't spin forever.
X_SCROLL_MAX_CYCLES = int(os.environ.get("X_PHASE1_SCROLL_CYCLES", "25"))
X_SCROLL_DELAY_S = int(os.environ.get("X_PHASE1_SCROLL_DELAY_SECONDS", "3"))


# ---------------------------------------------------------------------------
# Login state
# ---------------------------------------------------------------------------

def _is_logged_in_to_x(driver) -> bool:
    """True when the GoLogin session is signed into an X account.

    Logged-in X renders the left-nav account switcher + the Home tab; the
    login wall redirects to /login or /i/flow/login and shows a loginButton.
    Checked via JS so we read the live DOM, not a stale page_source."""
    try:
        return bool(driver.execute_script(
            """
            const u = location.href || '';
            if (/\\/(login|i\\/flow\\/login|account\\/access)/.test(u)) return false;
            if (document.querySelector('[data-testid="loginButton"]')) return false;
            return !!(
              document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
              document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
              document.querySelector('[aria-label="Account menu"]')
            );
            """
        ))
    except Exception:  # noqa: BLE001
        return False


def ensure_logged_in(driver, scraper_mod, *, interactive: bool, job_id: str | None,
                     worker_id: str | None, worker_port: int) -> bool:
    """Make sure the session is signed into X. Tries, in order: (1) the
    existing GoLogin session, (2) auto-login from the X_LOGIN_USERNAME /
    X_LOGIN_PASSWORD env credentials (handing any Arkose login captcha to
    2Captcha — same path the other engines use), (3) the noVNC checkpoint as a
    last resort (disabled in this deployment, so it usually just times out).
    Returns True when logged in."""
    try:
        driver.get(f"{X_BASE}/home")
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] could not open x.com/home: {exc}", file=sys.stderr)
    time.sleep(3)

    if _is_logged_in_to_x(driver):
        return True

    print("[INFO] X session is logged OUT — attempting auto-login", file=sys.stderr)

    # (2) Auto-login from the VM env burner credentials (mirrors Google login).
    username = os.environ.get("X_LOGIN_USERNAME")
    password = os.environ.get("X_LOGIN_PASSWORD")
    if username and password:
        try:
            outcome = scraper_mod.attempt_x_login(driver, username, password)
        except scraper_mod.InteractiveCancelException:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] x auto-login crashed: {exc}", file=sys.stderr)
            outcome = "failed"
        if outcome == "challenge":
            print("[INFO] x login: challenge detected — handing to 2Captcha")
            try:
                if scraper_mod.attempt_auto_captcha_solve(driver):
                    time.sleep(3)
            except Exception as exc:  # noqa: BLE001
                print(f"[WARN] x login: auto-captcha crashed: {exc}", file=sys.stderr)
        try:
            driver.get(f"{X_BASE}/home")
            time.sleep(3)
        except Exception:  # noqa: BLE001
            pass
        if _is_logged_in_to_x(driver):
            print("[INFO] x login: auto-login succeeded")
            return True
        print(f"[ERROR] x login: auto-login did not produce a signed-in session (outcome={outcome}). "
              "If X is demanding an email/SMS code or an unsolvable captcha, the burner account "
              "needs a manual first login / warming.", file=sys.stderr)
    else:
        print("[ERROR] X_LOGIN_USERNAME / X_LOGIN_PASSWORD not set in the VM env — cannot auto-login.",
              file=sys.stderr)

    # (3) Last resort: interactive noVNC checkpoint (disabled here; kept so it
    # works if live-view is ever enabled).
    if interactive and job_id:
        try:
            solved = scraper_mod.request_interactive_checkpoint(
                driver, job_id=job_id, worker_id=worker_id,
                worker_port=worker_port, reason="x_login",
            )
        except scraper_mod.InteractiveCancelException:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] X login checkpoint crashed: {exc}", file=sys.stderr)
            solved = False
        if solved:
            time.sleep(2)
            return _is_logged_in_to_x(driver)
    return False


# ---------------------------------------------------------------------------
# People-search extraction
# ---------------------------------------------------------------------------

# Parse the rendered UserCell list in the page. Returns [{username,
# display_name, bio}, ...]. Done in one JS pass (DOM is markup-class
# volatile but data-testid="UserCell" + the /{handle} link have been stable).
_USERCELL_JS = r"""
const out = [];
const seen = new Set();
const cells = document.querySelectorAll('[data-testid="UserCell"]');
for (const cell of cells) {
  // The handle link: an <a> whose href is exactly "/username" (no extra path).
  let username = null;
  for (const a of cell.querySelectorAll('a[role="link"][href^="/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (m) { username = m[1]; break; }
  }
  if (!username) continue;
  const key = username.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  // Display name: the UserName testid block holds "<name> @<handle>".
  let display_name = null;
  const nameEl = cell.querySelector('[data-testid="UserName"]') ||
                 cell.querySelector('[dir="ltr"]');
  if (nameEl) {
    const t = (nameEl.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
    // First line that isn't the @handle is the display name.
    display_name = (t.find(s => !s.startsWith('@')) || t[0] || '').slice(0, 200) || null;
  }

  // Bio: the UserDescription testid, falling back to the last dir=auto block.
  let bio = null;
  const bioEl = cell.querySelector('[data-testid="UserDescription"]');
  if (bioEl) bio = (bioEl.innerText || '').trim().slice(0, 2000) || null;

  out.push({ username, display_name, bio });
}
return out;
"""


def collect_user_cells(driver, max_results: int) -> list[dict[str, Any]]:
    """Scroll the People-search results, accumulating unique UserCells until
    we hit max_results or the list stops growing."""
    from selenium.webdriver.common.by import By

    by_username: dict[str, dict[str, Any]] = {}
    stale_cycles = 0
    for cycle in range(X_SCROLL_MAX_CYCLES):
        try:
            batch = driver.execute_script(_USERCELL_JS) or []
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] UserCell extraction crashed (cycle {cycle}): {exc}", file=sys.stderr)
            batch = []

        before = len(by_username)
        for u in batch:
            uname = (u.get("username") or "").strip()
            if not uname:
                continue
            key = uname.lower()
            if key not in by_username:
                by_username[key] = u
        gained = len(by_username) - before

        if len(by_username) >= max_results:
            break

        # No new cells for two cycles → the list is exhausted (or blocked).
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
        time.sleep(X_SCROLL_DELAY_S)

    return list(by_username.values())[:max_results]


def search_people(driver, keyword: str, max_results: int) -> list[dict[str, Any]]:
    """Navigate the People-search tab for `keyword` and return parsed cells."""
    url = f"{X_BASE}/search?q={quote(keyword)}&src=typed_query&f=user"
    driver.get(url)
    time.sleep(4)  # let the timeline hydrate
    # A logged-out redirect or an empty-state both yield zero cells — the
    # caller treats zero as a (successful) no-results run.
    return collect_user_cells(driver, max_results)


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def _build_rows(job_id: str, keyword: str, creators: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Shape parsed UserCells into x_creators row dicts. Split out so --dry-run
    can call it without supabase-py installed."""
    rows: list[dict[str, Any]] = []
    for c in creators:
        uname = (c.get("username") or "").strip()
        if not uname:
            continue
        rows.append({
            "scrape_queue_id": job_id,
            "username": uname,
            "profile_url": f"{X_BASE}/{uname}",
            "discovered_from_keyword": keyword,
            "display_name": c.get("display_name"),
            "bio": c.get("bio"),
        })
    return rows


def write_creators_to_db(sb, job_id: str, keyword: str, creators: list[dict[str, Any]]) -> int:
    rows = _build_rows(job_id, keyword, creators)
    if not rows:
        return 0
    sb.table("x_creators").insert(rows).execute()
    return len(rows)


def _write_summary(output_path: str, keyword: str, language: str, total: int) -> None:
    """Summary JSON for worker.py → complete_scrape_job. Shape mirrors
    kick_search.py / youtube_search.py so the dispatch path stays uniform."""
    summary = {
        "params": {"keyword": keyword, "language": language},
        "total_results": total,
        "organic_results": total,
        "ppc_results": 0,
        "pages_scraped": 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": True,   # X Phase 1 always runs from a logged-in session
        "results": [],          # creators live in x_creators, not this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


# ---------------------------------------------------------------------------
# GoLogin lifecycle (mirrors kick_profile_scrape.py / youtube_profile_scrape.py:
# defensive stop, bring-up retry loop, teardown on every exit path).
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
    for attempt in range(1, X_MAX_TRIES + 1):
        try:
            print(f"[INFO] GoLogin session bring-up (attempt {attempt}/{X_MAX_TRIES})")
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
            if attempt < X_MAX_TRIES:
                time.sleep(X_BLOCK_COOLDOWN_S)

    if not session_ok or driver is None:
        print("[ERROR] could not bring up a GoLogin session after retries", file=sys.stderr)
        try:
            gl.stop()
        except Exception:
            pass
        print("[RESULT] FAILED")
        return 2

    try:
        # Sign-in gate (X login wall). Park on noVNC when interactive.
        try:
            logged_in = ensure_logged_in(
                driver, scraper_mod, interactive=args.interactive, job_id=args.job_id,
                worker_id=args.worker_id, worker_port=args.port,
            )
        except scraper_mod.InteractiveCancelException:
            print("[INFO] operator cancelled at the X login checkpoint")
            print("[RESULT] FAILED")
            return 1
        if not logged_in:
            print("[ERROR] X session is not logged in — cannot search behind the login wall",
                  file=sys.stderr)
            print("[RESULT] FAILED")
            return 2

        print(f"[INFO] X People search | keyword={keyword!r} maxResults={args.max_results}")
        creators = search_people(driver, keyword, args.max_results)
        print(f"[INFO] parsed {len(creators)} unique creator(s) from People results")

        if args.mode == "probe":
            print("\n===== PROBE x_search =====")
            print(json.dumps(creators, indent=2, default=str)[:8000])
            print("===== END PROBE =====\n")
            print("[RESULT] SUCCESS")
            return 0

        if args.dry_run:
            rows = _build_rows(args.job_id, keyword, creators)
            print(f"[DRY-RUN] would insert {len(rows)} rows into x_creators.")
            if rows:
                print(json.dumps(rows[0], indent=2, default=str))
            _write_summary(args.output, keyword, args.language, len(rows))
            print(f"[DONE] X | Total: {len(rows)} creators (dry-run, no DB write)")
            print("[RESULT] SUCCESS")
            return 0

        try:
            inserted = write_creators_to_db(sb, args.job_id, keyword, creators)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] Supabase insert into x_creators failed: {exc}", file=sys.stderr)
            print("[RESULT] FAILED")
            return 3

        _write_summary(args.output, keyword, args.language, inserted)
        print(f"[DONE] X | Total: {inserted} creators inserted into x_creators")
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
    parser = argparse.ArgumentParser(description="X (x.com) creator search → x_creators (Phase 1)")
    parser.add_argument("profile_id", help="GoLogin profile ID (must be logged into a burner X account)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["search", "probe"], default="search",
                        help="'search' (default) writes x_creators; 'probe' dumps parsed cells for --query, no DB")
    parser.add_argument("-k", "--keyword", default="", help="Keyword to search the People tab for")
    parser.add_argument("--query", default=None, help="(probe mode) keyword to search")
    parser.add_argument("-c", "--country", default="", help="Country display name (logged only)")
    parser.add_argument("--country-code", dest="country_code", default="", help="ISO-2 country code (logged only)")
    parser.add_argument("--language", default="en", help="2-letter language code (Phase 1: logged only)")
    parser.add_argument("--max-results", type=int, default=100, help="Max creators to collect (default 100)")
    parser.add_argument("--job-id", dest="job_id", default=None, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--output", default="/tmp/x_search.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Park on noVNC if the X login wall is hit instead of failing")
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

    # Share captcha/login context with scraper.py's helpers (same mechanism as
    # kick_profile_scrape.py / youtube_profile_scrape.py main()).
    scraper_mod._CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    scraper_mod._CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)
    scraper_mod._CAPTCHA_SOLVER_CTX["country_code"] = (args.country_code or "").strip().upper() or None

    rc = run(args, scraper_mod)
    sys.exit(rc)


if __name__ == "__main__":
    main()
