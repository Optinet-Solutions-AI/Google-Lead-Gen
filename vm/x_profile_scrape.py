"""
X (x.com / twitter) creator profile enrichment worker (Phase 2).

Called as a subprocess by vm/worker.py for X scrape_queue jobs that carry a
parent_scrape_job_id (an operator-triggered ▶ "enrich profiles" job).
Phase 1 (x_search.py) discovers creators from the People-search tab and
captures username/display_name/bio. Phase 2 renders each x.com/{username}
profile in the authenticated GoLogin session and backfills the fields that
only live on the rendered profile page:

  - followers_count, following_count, tweet_count, location, verified,
    verified_type, account_created_at, profile_image_url, banner_url
  - website_url + the {instagram,youtube,tiktok,facebook}_handle socials
  - pinned_tweet_id, pinned_tweet_text
  - about_scraped_at (success marker; NULL stays for retry), about_fetch_failed
and inserts public.x_links rows with source 'bio' / 'pinned_tweet' /
'website' — the affiliate/casino link surfaces Phase 3 scores.

Like youtube_profile_scrape.py (and unlike kick_profile_scrape.py's
fresh-session-per-streamer), this uses ONE GoLogin session for the whole
batch: X serves many profiles from a single logged-in session, and a fresh
login per profile would trip X's "verify it's you" challenge. The session
must be signed into a (burner) X account (the login wall); when it isn't and
--interactive is set, we park on the noVNC checkpoint so an operator can
sign in once (cookies persist in the GoLogin profile).

Reuses vm/scraper.py's GoLogin/Selenium/captcha plumbing by import
(co-located in ~/ on the VM). scraper.py's main() is __main__-guarded.

CLI mirrors kick_profile_scrape.py / youtube_profile_scrape.py (profile_id
positional, --port, --parent-job-id, --top-n, the [RESULT] marker, summary
JSON to --output) so worker.py's dispatch path stays uniform.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed, or not logged into X
  exit 3 — Supabase read/write failure

A separate --mode probe (no DB, ignores --parent-job-id) visits one explicit
--username and dumps the parsed profile fields + links to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any

# scraper.py is only importable on the VM. Import lazily in main().

X_BASE = "https://x.com"

X_MAX_TRIES = int(os.environ.get("X_PHASE2_MAX_TRIES", "3"))
X_INTER_PROFILE_DELAY_S = int(os.environ.get("X_PHASE2_PROFILE_DELAY_SECONDS", "4"))
X_BLOCK_COOLDOWN_S = int(os.environ.get("X_PHASE2_BLOCK_COOLDOWN_SECONDS", "12"))
# Wall-clock budget: stop starting NEW profiles past this, finish what's done,
# exit SUCCESS — so the worker never kills us mid-run. Un-enriched creators
# stay pending for a re-run. Kept under the non-interactive worker timeout.
X_BUDGET_S = int(os.environ.get("X_PHASE2_BUDGET_SECONDS", "1000"))

# host (www-stripped) suffix → x_creators handle column. The creator's own
# platform is X, so there's no x_handle; these are OTHER platforms linked
# from the bio/website. Mirrors kick-contacts.ts SOCIAL_HOST_MAP.
_SOCIAL_HOST_MAP: list[tuple[tuple[str, ...], str]] = [
    (("instagram.com",), "instagram_handle"),
    (("youtube.com", "youtu.be", "m.youtube.com"), "youtube_handle"),
    (("tiktok.com", "vm.tiktok.com"), "tiktok_handle"),
    (("facebook.com", "fb.com", "fb.me"), "facebook_handle"),
]

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}


# ---------------------------------------------------------------------------
# Login state (same helpers as x_search.py — kept local so each worker is
# self-contained, mirroring how kick/youtube each carry their own).
# ---------------------------------------------------------------------------

def _is_logged_in_to_x(driver) -> bool:
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
    """Tries, in order: (1) the existing session, (2) auto-login from the
    X_LOGIN_USERNAME / X_LOGIN_PASSWORD env credentials (Arkose login captcha
    handed to 2Captcha), (3) the noVNC checkpoint (disabled in this deployment).
    Returns True when logged in."""
    try:
        driver.get(f"{X_BASE}/home")
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] could not open x.com/home: {exc}", file=sys.stderr)
    time.sleep(3)
    if _is_logged_in_to_x(driver):
        return True

    print("[INFO] X session is logged OUT — attempting auto-login", file=sys.stderr)

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
# Profile extraction
# ---------------------------------------------------------------------------

# One JS pass over the rendered profile header + pinned tweet. The
# data-testid hooks (UserName/UserDescription/UserUrl/UserLocation/
# UserJoinDate/tweetText/socialContext) have been stable across X's markup
# churn far longer than class names. Counts return {text,title}: X puts the
# exact integer in the span's title attribute and an abbreviated value in the
# visible text, so we prefer title and fall back to expanding "1.2M".
_PROFILE_JS = r"""
const res = {};
const txt = el => el ? (el.innerText || '').trim() : null;

function countFrom(suffixes){
  for (const suf of suffixes){
    const a = document.querySelector(`a[href$="${suf}"]`);
    if (a){
      let title = null;
      a.querySelectorAll('span').forEach(s => { if (s.title) title = s.title; });
      return { text: (a.innerText || '').trim(), title };
    }
  }
  return null;
}
res.following = countFrom(['/following']);
res.followers = countFrom(['/verified_followers', '/followers']);

res.bio = (() => { const e = document.querySelector('[data-testid="UserDescription"]');
  return e ? (e.innerText || '').trim().slice(0, 2000) || null : null; })();
res.location = txt(document.querySelector('[data-testid="UserLocation"]'));
res.joined = txt(document.querySelector('[data-testid="UserJoinDate"]'));
res.display_name = (() => {
  const e = document.querySelector('[data-testid="UserName"]'); if (!e) return null;
  const t = (e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
  return (t.find(s => !s.startsWith('@')) || t[0] || null);
})();

// tweet count — the primaryColumn heading shows "<name>\n<N> posts".
res.tweets = (() => {
  const h = document.querySelector('[data-testid="primaryColumn"] h2[role="heading"], [role="heading"][aria-level="1"]');
  if (!h) return null;
  const m = (h.innerText || '').match(/([\d.,]+\s*[KMB]?)\s*posts/i);
  return m ? m[1].trim() : null;
})();

// website card — X stores the real (expanded) URL in the anchor's title or
// href; the visible text is truncated.
res.website = (() => {
  const u = document.querySelector('[data-testid="UserUrl"]');
  if (!u) return null;
  const a = u.matches('a') ? u : u.querySelector('a');
  if (!a) return (u.innerText || '').trim() || null;
  return (a.getAttribute('title') || a.href || a.innerText || '').trim() || null;
})();

res.verified = !!(document.querySelector('[data-testid="UserName"] svg[data-testid="icon-verified"]')
  || document.querySelector('svg[aria-label="Verified account"]'));

res.avatar = (() => {
  const i = document.querySelector('a[href$="/photo"] img') || document.querySelector('img[src*="profile_images"]');
  return i ? i.src : null;
})();
res.banner = (() => {
  const i = document.querySelector('a[href$="/header_photo"] img') || document.querySelector('img[src*="profile_banners"]');
  return i ? i.src : null;
})();

// bio entity links (rendered as t.co anchors; Phase 3 resolves them).
res.bio_urls = [];
const desc = document.querySelector('[data-testid="UserDescription"]');
if (desc) desc.querySelectorAll('a[href]').forEach(a => {
  const href = a.getAttribute('href') || '';
  if (/^https?:/i.test(href)) res.bio_urls.push(href);
});

// pinned tweet — first article carrying a "Pinned" socialContext.
res.pinned_text = null; res.pinned_id = null; res.pinned_urls = [];
for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
  const sc = art.querySelector('[data-testid="socialContext"]');
  if (sc && /pinned/i.test(sc.innerText || '')) {
    const te = art.querySelector('[data-testid="tweetText"]');
    res.pinned_text = te ? (te.innerText || '').trim().slice(0, 2000) : null;
    const link = art.querySelector('a[href*="/status/"]');
    if (link) { const m = (link.getAttribute('href') || '').match(/\/status\/(\d+)/); if (m) res.pinned_id = m[1]; }
    art.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) res.pinned_urls.push(href);
    });
    break;
  }
}
return res;
"""


def _parse_count(obj: Any) -> int | None:
    """Parse a {text,title} count object → int. Prefers the exact title value
    (e.g. "12,345"), falls back to expanding the visible "1.2M" / "10.5K"."""
    if not isinstance(obj, dict):
        return None
    title = obj.get("title") or ""
    digits = re.sub(r"[^\d]", "", title)
    if digits:
        try:
            return int(digits)
        except ValueError:
            pass
    text = obj.get("text") or ""
    m = re.search(r"([\d.,]+)\s*([KMB])?", text, re.I)
    if not m:
        return None
    num = m.group(1).replace(",", "")
    suffix = (m.group(2) or "").upper()
    try:
        val = float(num)
    except ValueError:
        return None
    mult = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get(suffix, 1)
    return int(val * mult)


def _parse_joined(joined: str | None) -> str | None:
    """"Joined September 2011" → "2011-09-01" (ISO date). Best effort."""
    if not joined:
        return None
    m = re.search(r"([A-Za-z]+)\s+(\d{4})", joined)
    if not m:
        return None
    month = _MONTHS.get(m.group(1).lower())
    if not month:
        return None
    return f"{m.group(2)}-{month:02d}-01"


def _clean_host(url: str) -> str:
    from urllib.parse import urlparse
    try:
        h = (urlparse(url).hostname or "").lower()
        return h[4:] if h.startswith("www.") else h
    except Exception:  # noqa: BLE001
        return ""


def _social_handle_for(url: str) -> str | None:
    host = _clean_host(url)
    if not host:
        return None
    for hosts, col in _SOCIAL_HOST_MAP:
        if any(host == h or host.endswith("." + h) for h in hosts):
            return col
    return None


def parse_profile(driver) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run the JS extractor and shape it into (x_creators fields, x_links rows).

    Empty bio/links are legitimate — the caller treats a rendered profile (with
    a follower count, which every account has) as successfully enriched."""
    raw = driver.execute_script(_PROFILE_JS) or {}

    fields: dict[str, Any] = {}
    if raw.get("display_name"):
        fields["display_name"] = raw["display_name"]
    if raw.get("bio") is not None:
        fields["bio"] = raw["bio"]
    if raw.get("location"):
        fields["location"] = raw["location"]
    followers = _parse_count(raw.get("followers"))
    if followers is not None:
        fields["followers_count"] = followers
    following = _parse_count(raw.get("following"))
    if following is not None:
        fields["following_count"] = following
    tweets = _parse_count({"text": raw.get("tweets")} if raw.get("tweets") else None)
    if tweets is not None:
        fields["tweet_count"] = tweets
    fields["verified"] = bool(raw.get("verified"))
    joined = _parse_joined(raw.get("joined"))
    if joined:
        fields["account_created_at"] = joined
    if raw.get("avatar"):
        fields["profile_image_url"] = raw["avatar"]
    if raw.get("banner"):
        fields["banner_url"] = raw["banner"]
    if raw.get("pinned_id"):
        fields["pinned_tweet_id"] = raw["pinned_id"]
    if raw.get("pinned_text"):
        fields["pinned_tweet_text"] = raw["pinned_text"]

    website = (raw.get("website") or "").strip()
    if website:
        if not re.match(r"^https?://", website, re.I):
            website = "https://" + website
        fields["website_url"] = website

    # Build x_links rows + fill social *_handle columns (first link wins).
    links: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add_link(url: str, source: str) -> None:
        url = (url or "").strip()
        if not url:
            return
        key = (source, url)
        if key in seen:
            return
        seen.add(key)
        links.append({"url": url, "source": source})
        col = _social_handle_for(url)
        if col and col not in fields:
            fields[col] = url

    if website:
        add_link(website, "website")
    for u in raw.get("bio_urls") or []:
        add_link(u, "bio")
    for u in raw.get("pinned_urls") or []:
        add_link(u, "pinned_tweet")

    return fields, links


_NOT_FOUND_RE = re.compile(
    r"this account doesn.t exist|account suspended|caret to expand", re.I,
)


def _profile_unavailable(driver) -> bool:
    """Suspended / non-existent account detector."""
    try:
        body = driver.find_element("tag name", "body").text or ""
    except Exception:  # noqa: BLE001
        body = ""
    if "Account suspended" in body or "doesn’t exist" in body or "doesn't exist" in body:
        return True
    return False


def _wait_for_profile(driver, timeout_s: int = 12) -> None:
    """Poll until the profile header (UserName) is in the DOM."""
    from selenium.webdriver.common.by import By
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if driver.find_elements(By.CSS_SELECTOR, '[data-testid="UserName"]'):
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.5)


def enrich_one(driver, scraper_mod, username: str, *, interactive: bool,
               job_id: str | None, worker_id: str | None, worker_port: int) -> dict[str, Any]:
    """Navigate x.com/{username}, wait for the header, extract.

    Returns {"ok": bool, "fields": {...}, "links": [...]}. ok=False means the
    page couldn't be read (nav error, login wall, suspended) — caller leaves
    about_scraped_at NULL so a re-run retries."""
    url = f"{X_BASE}/{username}"
    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {username}: navigation failed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    time.sleep(2)

    # A mid-batch logout (session expired) → bail clearly rather than record
    # every remaining profile as a false "enriched" with empty data.
    if not _is_logged_in_to_x(driver):
        print(f"[WARN] {username}: session no longer logged in", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    if _profile_unavailable(driver):
        print(f"[INFO] {username}: account suspended / doesn't exist", file=sys.stderr)
        # Distinct from a transient block — record as a (permanent) failure so
        # it isn't retried forever. Caller marks about_fetch_failed.
        return {"ok": False, "fields": {}, "links": [], "permanent": True}

    _wait_for_profile(driver)

    try:
        fields, links = parse_profile(driver)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {username}: extraction crashed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    if "followers_count" not in fields:
        # Header never hydrated (block / rate-limit) — every real account has a
        # follower count (even 0). Retry on a fresh attempt instead of recording
        # a false "enriched".
        print(f"[WARN] {username}: profile did not hydrate (no follower count)", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    return {"ok": True, "fields": fields, "links": links}


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def fetch_target_creators(sb, parent_job_id: str, top_n: int) -> list[dict[str, Any]]:
    """Top-N not-yet-enriched creators of the parent Phase-1 job. There's no
    follower count yet (Phase 2 fills it), so order by discovery order (id).

    Skips rows marked about_fetch_failed — those are permanent failures
    (suspended / gone accounts; see enrich_one) that can never succeed, so
    re-selecting them on every Enrich run just wastes a GoLogin session and
    keeps 'pending' from ever reaching zero."""
    res = (
        sb.table("x_creators")
        .select("id, username")
        .eq("scrape_queue_id", parent_job_id)
        .is_("about_scraped_at", "null")
        .or_("about_fetch_failed.is.null,about_fetch_failed.eq.false")
        .order("id", desc=False)
        .limit(top_n)
        .execute()
    )
    return res.data or []


def write_enrichment(sb, creator_id: str, fields: dict[str, Any], links: list[dict[str, Any]]) -> None:
    update = dict(fields)
    update["about_fetch_failed"] = False
    update["about_scraped_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sb.table("x_creators").update(update).eq("id", creator_id).execute()
    if links:
        rows = [{**l, "x_creator_id": creator_id} for l in links]
        sb.table("x_links").insert(rows).execute()


def mark_failed(sb, creator_id: str) -> None:
    sb.table("x_creators").update({"about_fetch_failed": True}).eq("id", creator_id).execute()


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
        "is_logged_in": True,
        "results": [],
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


# ---------------------------------------------------------------------------
# GoLogin lifecycle (mirrors youtube_profile_scrape.py: one session for the
# whole batch, login once, loop, time-budget guard, teardown).
# ---------------------------------------------------------------------------

def run(args, scraper_mod) -> int:
    from gologin import GoLogin

    gologin_token = os.environ.get("GOLOGIN_API_TOKEN")
    if not gologin_token:
        print("[ERROR] GOLOGIN_API_TOKEN is not set", file=sys.stderr)
        return 1

    sb = None
    if args.mode == "enrich":
        sb_url = os.environ.get("SUPABASE_URL")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not args.dry_run and (not sb_url or not sb_key):
            print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
            return 1
        if sb_url and sb_key:
            from supabase import create_client
            sb = create_client(sb_url, sb_key)

    if args.mode == "probe":
        targets = [{"id": None, "username": args.username}]
    else:
        if not sb:
            print("[ERROR] need Supabase creds to select target creators", file=sys.stderr)
            return 3
        try:
            targets = fetch_target_creators(sb, args.parent_job_id, args.top_n)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] selecting target creators failed: {exc}", file=sys.stderr)
            return 3
        if not targets:
            print("[INFO] no un-enriched creators for this parent job — nothing to do")
            _write_summary(args.output, args.parent_job_id, 0, 0, 0)
            print("[RESULT] SUCCESS")
            return 0
        print(f"[INFO] enriching {len(targets)} creator(s) (top-{args.top_n}) "
              f"for parent job {args.parent_job_id[:8]}")

    gl = GoLogin({"token": gologin_token, "profile_id": args.profile_id, "port": args.port})
    try:
        gl.stop()
    except Exception:
        pass
    time.sleep(3)

    attempted = enriched = failed = 0
    run_start = time.time()

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
            # Sign into X ONCE per session (login wall + expensive re-login).
            if not ensure_logged_in(
                driver, scraper_mod, interactive=args.interactive, job_id=args.job_id,
                worker_id=args.worker_id, worker_port=args.port,
            ):
                print("[ERROR] X session is not logged in — cannot enrich behind the login wall",
                      file=sys.stderr)
                _teardown(driver, gl)
                if args.mode != "probe":
                    _write_summary(args.output, args.parent_job_id, 0, 0, len(targets))
                print("[RESULT] FAILED")
                return 2
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
        print("[ERROR] could not bring up a logged-in GoLogin session after retries", file=sys.stderr)
        try:
            gl.stop()
        except Exception:
            pass
        if args.mode != "probe":
            _write_summary(args.output, args.parent_job_id, 0, 0, len(targets))
        print("[RESULT] FAILED")
        return 2

    try:
        for t in targets:
            if args.mode != "probe" and (enriched + failed) > 0 and (time.time() - run_start) > X_BUDGET_S:
                remaining = len(targets) - attempted
                print(f"[INFO] time budget ({X_BUDGET_S}s) reached — stopping with "
                      f"{remaining} creator(s) still pending (re-run to continue)")
                break

            username = t["username"]
            attempted += 1
            try:
                result = enrich_one(
                    driver, scraper_mod, username,
                    interactive=args.interactive, job_id=args.job_id,
                    worker_id=args.worker_id, worker_port=args.port,
                )
            except scraper_mod.InteractiveCancelException:
                print("[INFO] operator cancelled at Captcha solver checkpoint")
                _teardown(driver, gl)
                print("[RESULT] FAILED")
                return 1
            except Exception as exc:  # noqa: BLE001
                print(f"[ERROR] {username}: enrichment crashed: {exc}", file=sys.stderr)
                result = {"ok": False, "fields": {}, "links": []}

            if args.mode == "probe":
                print(f"\n===== PROBE {username} =====")
                print("----- fields -----")
                print(json.dumps(result.get("fields", {}), indent=2, default=str))
                print(f"----- x_links ({len(result.get('links', []))}) -----")
                print(json.dumps(result.get("links", []), indent=2, default=str))
                print(f"===== END PROBE {username} =====\n")
                continue

            if not result["ok"]:
                failed += 1
                # Mark permanent failures (suspended/gone) so they aren't
                # retried forever; transient blocks stay pending (NULL).
                if not args.dry_run and t["id"] is not None and result.get("permanent"):
                    mark_failed(sb, t["id"])
                print(f"[WARN] {username}: enrichment failed", file=sys.stderr)
            elif args.dry_run:
                enriched += 1
                print(f"[DRY-RUN] {username}: fields={json.dumps(result['fields'], default=str)} "
                      f"links={len(result['links'])}")
            else:
                write_enrichment(sb, t["id"], result["fields"], result["links"])
                enriched += 1
                print(f"[INFO] {username}: enriched ({len(result['fields'])} fields, "
                      f"{len(result['links'])} links)")

            time.sleep(X_INTER_PROFILE_DELAY_S)  # pace requests
    finally:
        _teardown(driver, gl)

    if args.mode == "probe":
        print("[RESULT] SUCCESS")
        return 0

    _write_summary(args.output, args.parent_job_id, attempted, enriched, failed)
    print(f"[DONE] X Phase 2 | attempted={attempted} enriched={enriched} failed={failed}")
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


def main() -> None:
    parser = argparse.ArgumentParser(description="X (x.com) creator profile enrichment (Phase 2)")
    parser.add_argument("profile_id", help="GoLogin profile ID (must be logged into a burner X account)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["enrich", "probe"], default="enrich",
                        help="'enrich' (default) backfills DB; 'probe' dumps one --username, no DB")
    parser.add_argument("--username", default=None, help="(probe mode) single @handle to dump (no @)")
    parser.add_argument("--parent-job-id", dest="parent_job_id", default=None,
                        help="Phase-1 scrape_queue.id whose creators to enrich")
    parser.add_argument("--top-n", dest="top_n", type=int, default=25,
                        help="Max creators to enrich this run")
    parser.add_argument("--job-id", dest="job_id", default=None,
                        help="This Phase-2 scrape_queue.id (for captcha/login checkpoints)")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--country-code", dest="country_code", default="", help="ISO-2 of the profile (logged)")
    parser.add_argument("--output", default="/tmp/x_phase2.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Park on noVNC if the X login wall is hit instead of failing")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the browser + extraction but skip all DB writes")
    args = parser.parse_args()

    if args.mode == "probe" and not args.username:
        print("[ERROR] --mode probe requires --username", file=sys.stderr)
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

    scraper_mod._CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    scraper_mod._CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)
    scraper_mod._CAPTCHA_SOLVER_CTX["country_code"] = (args.country_code or "").strip().upper() or None

    rc = run(args, scraper_mod)
    sys.exit(rc)


if __name__ == "__main__":
    main()
