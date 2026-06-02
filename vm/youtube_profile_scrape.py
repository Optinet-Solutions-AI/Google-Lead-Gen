"""
YouTube channel contact-enrichment worker (Phase 2).

Called as a subprocess by vm/worker.py for YouTube scrape_queue jobs that
carry a parent_scrape_job_id (an operator-triggered ▶ "enrich contacts"
job). Phase 1 (youtube_search.py) discovers channels via the YouTube Data
API; Phase 2 fills the OUTREACH contacts that only live on the rendered
channel About tab and aren't exposed by the API:

  - website_url, twitter_url, instagram_url, tiktok_url, telegram_url,
    discord_url   (the channel's "Links" section)
  - email         (the "View email address" button → reCAPTCHA-gated)
  - about_tab_scraped_at  (success marker; NULL stays for retry)
  - about_tab_captcha_blocked  (set when the email reveal was gated by a
    reCAPTCHA we couldn't clear — website/socials are still captured)

Mirrors kick_profile_scrape.py's contract exactly (CLI args, [RESULT]
marker, summary JSON to --output) so worker.py's dispatch path stays
uniform, and reuses vm/scraper.py's GoLogin/Selenium/captcha plumbing by
import — the two files are co-located in ~/ on the VM, so `import scraper`
resolves to ~/scraper.py. scraper.py's main() is __main__-guarded, so
importing it has no side effects.

Unlike kick.com, youtube.com is NOT behind Cloudflare and serves to raw
clients fine — but the email reveal is gated by Google reCAPTCHA (a
DIFFERENT captcha type than the Bing Turnstile attempt_auto_captcha_solve
is verified on), and a Google consent interstitial can appear in some
regions. We attempt the reveal and degrade gracefully: on an unsolved
reCAPTCHA we record about_tab_captcha_blocked=true and keep the rest.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed after retries
  exit 3 — Supabase read/write failure

A separate --probe MODE (does not touch the DB, ignores --parent-job-id)
visits one explicit --channel and dumps the About-tab links + ytInitialData
+ page HTML to stdout. Used for the one-time VM spike that confirms exact
DOM structure + whether the reCAPTCHA email reveal solves, before the
parsers are hardened.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from html import unescape
from urllib.parse import parse_qs, unquote, urlparse
from typing import Any

# scraper.py (and its gologin/selenium imports) is only importable on the
# VM. Import lazily in main() so `--help` works anywhere.

YOUTUBE_BASE = "https://www.youtube.com"

# Failure mitigation (rate-limit / soft-block under load):
#   - more fresh-IP tries per channel → better odds of an un-flagged IP
#   - pacing (delays) → IPs get flagged less and recover between uses
# All env-tunable so we can dial reliability vs speed without a redeploy.
YT_MAX_TRIES = int(os.environ.get("YOUTUBE_PHASE2_MAX_TRIES", "3"))
YT_INTER_CHANNEL_DELAY_S = int(os.environ.get("YOUTUBE_PHASE2_CHANNEL_DELAY_SECONDS", "5"))
YT_BLOCK_COOLDOWN_S = int(os.environ.get("YOUTUBE_PHASE2_BLOCK_COOLDOWN_SECONDS", "12"))
# Wall-clock budget: stop starting NEW channels past this, finish what's
# done, and exit SUCCESS — so the job never gets killed mid-run by the
# worker's subprocess timeout (which would requeue + re-burn the batch).
# Kept under the non-interactive worker timeout (1200s); un-enriched
# channels stay pending for a re-run.
YT_BUDGET_S = int(os.environ.get("YOUTUBE_PHASE2_BUDGET_SECONDS", "1000"))

# ---------------------------------------------------------------------------
# Link classification — the About "Links" section holds the channel's
# website + socials. A link's host decides which contact column it fills;
# first link for a column wins. Mirrors lib/affiliate-detection/kick-contacts.ts
# so the in-app Phase 3 and this scrape agree on what counts as what.
# ---------------------------------------------------------------------------

# host (www-stripped) suffix → youtube_channels column.
_LINK_HOST_MAP: list[tuple[tuple[str, ...], str]] = [
    (("twitter.com", "x.com"), "twitter_url"),
    (("instagram.com",), "instagram_url"),
    (("tiktok.com", "vm.tiktok.com"), "tiktok_url"),
    (("t.me", "telegram.me", "telegram.dog"), "telegram_url"),
    (("discord.gg", "discord.com", "discordapp.com"), "discord_url"),
]

# Socials/contacts get their own column; anything else off-youtube that
# isn't one of these is treated as the channel's website (first wins).
# Excludes Google/YouTube's own chrome — sign-in links (accounts.google.com
# ServiceLogin) appear when the GoLogin profile isn't logged into Google and
# must NOT be mistaken for the channel's website. facebook has no column, so
# it's parked here too rather than polluting website_url.
_NON_WEBSITE_HOSTS = {
    "youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com",
    "accounts.google.com", "google.com", "support.google.com", "policies.google.com",
    "facebook.com", "fb.com", "fb.me",
}

_EMAIL_RE = re.compile(
    r"[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}", re.I
)
_EMAIL_ASSET_RE = re.compile(r"\.(png|jpe?g|gif|webp|svg|ico|css|js|mp4|webm|woff2?)$", re.I)


def _clean_host(url: str) -> str:
    try:
        h = (urlparse(url).hostname or "").lower()
        return h[4:] if h.startswith("www.") else h
    except Exception:  # noqa: BLE001
        return ""


def _unwrap_redirect(url: str) -> str:
    """YouTube wraps external links as youtube.com/redirect?q=<encoded>.
    Unwrap to the real destination; pass through anything else.

    ytInitialData serves these URLs HTML-entity-encoded (&amp; for &), which
    breaks query parsing — unescape first so the q= param is found."""
    url = unescape(url or "")
    try:
        p = urlparse(url)
    except Exception:  # noqa: BLE001
        return url
    if p.hostname and "youtube.com" in p.hostname and p.path.startswith("/redirect"):
        q = parse_qs(p.query).get("q") or parse_qs(p.query).get("u")
        if q:
            return unquote(q[0])
    return url


def _is_discord_invite(host: str, url: str) -> bool:
    if host == "discord.gg":
        return True
    if host in ("discord.com", "discordapp.com"):
        return "/invite/" in url.lower()
    return False


def classify_links(urls: list[str]) -> dict[str, str]:
    """Fold a list of (unwrapped) external URLs into contact columns.
    First link for a column wins. Returns only the columns that filled."""
    fields: dict[str, str] = {}
    for raw in urls:
        url = _unwrap_redirect((raw or "").strip())
        if not url:
            continue
        host = _clean_host(url)
        if not host:
            continue
        matched = False
        for hosts, col in _LINK_HOST_MAP:
            if any(host == h or host.endswith("." + h) for h in hosts):
                if col == "discord_url" and not _is_discord_invite(host, url):
                    matched = True
                    break
                fields.setdefault(col, url)
                matched = True
                break
        if matched:
            continue
        # Not a known social/contact host → candidate website (first wins).
        if host not in _NON_WEBSITE_HOSTS and "website_url" not in fields:
            fields["website_url"] = url
    return fields


# ---------------------------------------------------------------------------
# Page extraction
# ---------------------------------------------------------------------------

def _collect_about_urls(driver) -> list[str]:
    """Pull candidate external link URLs from the About tab — both the
    rendered anchor hrefs and the ytInitialData JSON blob (belt + braces,
    since YouTube reshuffles its markup often)."""
    urls: list[str] = []
    from selenium.webdriver.common.by import By

    # 1. Rendered anchors (links section renders as <a href="...redirect?q=">).
    try:
        for a in driver.find_elements(By.CSS_SELECTOR, "a[href]"):
            try:
                href = a.get_attribute("href") or ""
            except Exception:  # noqa: BLE001
                continue
            if "youtube.com/redirect" in href or (
                href.startswith("http") and "youtube.com" not in (urlparse(href).hostname or "")
            ):
                urls.append(href)
    except Exception:  # noqa: BLE001
        pass

    # 2. ytInitialData redirect links (catches links the DOM lazy-renders).
    try:
        html = driver.page_source or ""
    except Exception:  # noqa: BLE001
        html = ""
    for m in re.findall(r'"(https?://www\.youtube\.com/redirect\?[^"]+)"', html):
        urls.append(m.replace("\\u0026", "&").replace("\\/", "/"))

    # Dedupe (order-preserving) on the unwrapped destination.
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        dest = _unwrap_redirect(u)
        if dest in seen:
            continue
        seen.add(dest)
        out.append(u)
    return out


def _attempt_email_reveal(driver, scraper_mod, *, interactive: bool,
                          job_id: str | None, worker_id: str | None,
                          worker_port: int) -> tuple[str | None, bool]:
    """Click "View email address" and try to clear the reCAPTCHA gate.

    Returns (email_or_None, captcha_blocked). captcha_blocked=True means a
    reCAPTCHA appeared and we couldn't clear it — the caller records the flag
    and keeps whatever website/socials it captured.
    """
    from selenium.webdriver.common.by import By

    # Find the reveal trigger by visible text (markup-class agnostic).
    btn = None
    try:
        candidates = driver.find_elements(
            By.XPATH,
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
            "'abcdefghijklmnopqrstuvwxyz'), 'view email address')]",
        )
        btn = candidates[0] if candidates else None
    except Exception:  # noqa: BLE001
        btn = None

    if btn is None:
        # No reveal button → this channel simply doesn't publish a business
        # email. Not a captcha block.
        return None, False

    try:
        driver.execute_script("arguments[0].click();", btn)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] email-reveal click failed: {exc}", file=sys.stderr)
        return None, False

    time.sleep(2)  # let the reveal dialog / reCAPTCHA mount

    # A reCAPTCHA challenge present?
    captcha_present = False
    try:
        captcha_present = bool(
            driver.find_elements(By.CSS_SELECTOR, "iframe[src*='recaptcha'], iframe[title*='recaptcha' i]")
        )
    except Exception:  # noqa: BLE001
        pass

    if captcha_present:
        solved = False
        try:
            solved = scraper_mod.attempt_auto_captcha_solve(driver)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] auto-solve crashed on YouTube reCAPTCHA: {exc}", file=sys.stderr)
        if not solved and interactive and job_id:
            try:
                solved = scraper_mod.request_interactive_checkpoint(
                    driver, job_id=job_id, worker_id=worker_id,
                    worker_port=worker_port, reason="youtube_email_recaptcha",
                )
            except scraper_mod.InteractiveCancelException:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"[WARN] checkpoint crashed: {exc}", file=sys.stderr)
        if not solved:
            return None, True
        time.sleep(2)  # let the revealed email render after solve

    email = _read_revealed_email(driver)
    return email, False


def _read_revealed_email(driver) -> str | None:
    """Scan the page for a revealed business email (mailto: first, then a
    plain-text email in the dialog). Skips asset-filename false positives."""
    from selenium.webdriver.common.by import By
    # mailto: anchors are the cleanest signal.
    try:
        for a in driver.find_elements(By.CSS_SELECTOR, "a[href^='mailto:']"):
            href = (a.get_attribute("href") or "")[len("mailto:"):].split("?")[0].strip().lower()
            if "@" in href and not _EMAIL_ASSET_RE.search(href):
                return href
    except Exception:  # noqa: BLE001
        pass
    # Fallback: regex over the rendered text.
    try:
        text = driver.find_element(By.TAG_NAME, "body").text or ""
    except Exception:  # noqa: BLE001
        text = ""
    for m in _EMAIL_RE.finditer(text):
        e = m.group(0).lower()
        if not _EMAIL_ASSET_RE.search(e):
            return e
    return None


# Multilingual "Accept all" labels for the consent wall (the logged-in
# profiles are GB/DE/NO, so EN/DE/NO must all work; a few extras are cheap).
_CONSENT_ACCEPT_TEXTS = [
    "accept all", "accept the all", "i agree", "agree to all", "agree",
    "alle akzeptieren", "akzeptieren",          # DE
    "godta alle", "godta",                       # NO
    "tout accepter", "aceptar todo", "accetta tutto",
]


def _on_consent_wall(driver) -> bool:
    try:
        url = driver.current_url or ""
    except Exception:  # noqa: BLE001
        url = ""
    if "consent.youtube.com" in url or "consent.google.com" in url:
        return True
    try:
        return "youtube" in (driver.title or "").lower() and "consent" in url.lower()
    except Exception:  # noqa: BLE001
        return False


def _dismiss_consent(driver, channel_id: str | None = None) -> None:
    """Clear Google's EU/UK consent interstitial ("Before you continue to
    YouTube"). The logged-in profiles are all EU/UK, so this fires on every
    enrichment run. Language-independent: click the accept-all button by its
    stable jsname, with a multilingual text fallback, then wait for the
    redirect back to the continue= URL."""
    from selenium.webdriver.common.by import By
    if not _on_consent_wall(driver):
        return

    clicked = False
    # 1. Stable jsname for the consent "Accept all" button (works regardless
    #    of UI language). Reject-all is tWT92d; accept-all is b3VHJd.
    try:
        els = driver.find_elements(By.CSS_SELECTOR, 'button[jsname="b3VHJd"], [jsname="b3VHJd"]')
        if els:
            driver.execute_script("arguments[0].click();", els[0])
            clicked = True
    except Exception:  # noqa: BLE001
        pass

    # 2. Text fallback (multilingual) if the jsname changed.
    if not clicked:
        try:
            for b in driver.find_elements(By.XPATH, "//button | //*[@role='button']"):
                try:
                    label = ((b.text or "") + " " + (b.get_attribute("aria-label") or "")).strip().lower()
                except Exception:  # noqa: BLE001
                    continue
                if any(t in label for t in _CONSENT_ACCEPT_TEXTS):
                    driver.execute_script("arguments[0].click();", b)
                    clicked = True
                    break
        except Exception:  # noqa: BLE001
            pass

    if not clicked:
        print("[WARN] consent wall present but no accept button matched", file=sys.stderr)
        return

    # Wait for the post-accept redirect off consent.youtube.com.
    deadline = time.time() + 12
    while time.time() < deadline:
        time.sleep(1.5)
        if not _on_consent_wall(driver):
            return
    print("[WARN] clicked consent accept but still on the consent wall", file=sys.stderr)


def extract_from_page(driver, scraper_mod, *, interactive: bool, job_id: str | None,
                      worker_id: str | None, worker_port: int) -> dict[str, Any]:
    """Parse the About tab → contact fields. Returns the fields dict, with
    about_tab_captcha_blocked set when the email reveal was gated."""
    urls = _collect_about_urls(driver)
    fields = classify_links(urls)

    email, blocked = _attempt_email_reveal(
        driver, scraper_mod, interactive=interactive, job_id=job_id,
        worker_id=worker_id, worker_port=worker_port,
    )
    if email:
        fields["email"] = email
    fields["about_tab_captcha_blocked"] = bool(blocked)
    return fields


# ---------------------------------------------------------------------------
# Per-channel visit
# ---------------------------------------------------------------------------

def enrich_one(driver, scraper_mod, channel_id: str, *, interactive: bool,
               job_id: str | None, worker_id: str | None, worker_port: int) -> dict[str, Any]:
    """Navigate the channel About tab and extract contacts.

    Returns {"ok": bool, "fields": {...}}. ok=False means the page couldn't
    be read (nav error, soft block) — caller retries on a fresh session and
    ultimately leaves about_tab_scraped_at NULL so a re-run retries.
    """
    url = f"{YOUTUBE_BASE}/channel/{channel_id}/about"
    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {channel_id}: navigation failed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}}

    time.sleep(2)
    _dismiss_consent(driver, channel_id)
    time.sleep(2)  # let the About page render after the consent redirect

    try:
        html = driver.page_source or ""
    except Exception:  # noqa: BLE001
        html = ""
    if len(html) < 5000:
        print(f"[WARN] {channel_id}: page did not render (len={len(html)}) — likely soft block",
              file=sys.stderr)
        return {"ok": False, "fields": {}}

    try:
        fields = extract_from_page(
            driver, scraper_mod, interactive=interactive, job_id=job_id,
            worker_id=worker_id, worker_port=worker_port,
        )
    except scraper_mod.InteractiveCancelException:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {channel_id}: extraction crashed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}}

    return {"ok": True, "fields": fields}


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def fetch_target_channels(sb, parent_job_id: str, top_n: int) -> list[dict[str, Any]]:
    """Top-N not-yet-enriched channels of the parent Phase-1 job, ranked by
    subscriber count."""
    res = (
        sb.table("youtube_channels")
        .select("id, channel_id, subscriber_count")
        .eq("scrape_queue_id", parent_job_id)
        .is_("about_tab_scraped_at", "null")
        .order("subscriber_count", desc=True, nullsfirst=False)
        .limit(top_n)
        .execute()
    )
    return res.data or []


def write_enrichment(sb, channel_row_id: str, fields: dict[str, Any]) -> None:
    """Update the channel row, marking about_tab_scraped_at. Called only on a
    successful read."""
    update = dict(fields)
    # supabase-py can't send a raw SQL now() through .update(); a client UTC
    # stamp keeps the write a single round-trip. (The updated_at trigger on
    # youtube_channels still fires server-side.)
    update["about_tab_scraped_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sb.table("youtube_channels").update(update).eq("id", channel_row_id).execute()


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
# GoLogin lifecycle (mirrors kick_profile_scrape.py / scraper.py main()).
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

    # Build the work-list up front (probe mode is a single explicit channel).
    if args.mode == "probe":
        targets = [{"id": None, "channel_id": args.channel}]
    else:
        if not sb:
            print("[ERROR] need Supabase creds to select target channels", file=sys.stderr)
            return 3
        try:
            targets = fetch_target_channels(sb, args.parent_job_id, args.top_n)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] selecting target channels failed: {exc}", file=sys.stderr)
            return 3
        if not targets:
            print("[INFO] no un-enriched channels for this parent job — nothing to do")
            _write_summary(args.output, args.parent_job_id, 0, 0, 0)
            print("[RESULT] SUCCESS")
            return 0
        print(f"[INFO] enriching {len(targets)} channel(s) (top-{args.top_n}) "
              f"for parent job {args.parent_job_id[:8]}")

    gl = GoLogin({"token": gologin_token, "profile_id": args.profile_id, "port": args.port})
    try:
        gl.stop()
    except Exception:
        pass
    time.sleep(3)

    attempted = enriched = failed = 0
    run_start = time.time()

    # ONE GoLogin session for the whole batch. Unlike Kick (whose WAF blocks
    # the 2nd+ request per session), YouTube serves many About tabs from a
    # single session — and the Google login below is expensive and trips
    # Google's "verify it's you" if repeated, so we sign in ONCE then loop.
    # Bring-up gets a few tries to ride out a transient GoLogin/proxy hiccup.
    driver = None
    session_ok = False
    for attempt in range(1, YT_MAX_TRIES + 1):
        try:
            print(f"[INFO] GoLogin session bring-up (attempt {attempt}/{YT_MAX_TRIES})")
            debugger_address = gl.start()
            time.sleep(2)
            driver = scraper_mod.connect_to_gologin_browser(debugger_address)
            scraper_mod._install_turnstile_interceptor(driver)
            if not scraper_mod.check_browser_connectivity(driver):
                raise RuntimeError("Browser connectivity check failed — proxy may be unreachable")
            # Sign into Google ONCE. The About-tab email reveal only renders
            # for a logged-in viewer; ensure_google_login_if_required reads
            # country_code / requires_google_login from _CAPTCHA_SOLVER_CTX
            # (set in main()), auto-logs-in from the stored per-country creds,
            # and escalates a Google challenge to the interactive checkpoint
            # when enabled. No-op for already-signed-in / login-not-required.
            try:
                scraper_mod.ensure_google_login_if_required(driver)
            except scraper_mod.InteractiveCancelException:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"[WARN] google login step crashed (continuing logged-out): {exc}",
                      file=sys.stderr)
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
            if attempt < YT_MAX_TRIES:
                time.sleep(YT_BLOCK_COOLDOWN_S)

    if not session_ok or driver is None:
        print("[ERROR] could not bring up a GoLogin session after retries", file=sys.stderr)
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
            if args.mode != "probe" and (enriched + failed) > 0 and (time.time() - run_start) > YT_BUDGET_S:
                remaining = len(targets) - attempted
                print(f"[INFO] time budget ({YT_BUDGET_S}s) reached — stopping with "
                      f"{remaining} channel(s) still pending (re-run to continue)")
                break

            channel_id = t["channel_id"]
            attempted += 1
            try:
                result = enrich_one(
                    driver, scraper_mod, channel_id,
                    interactive=args.interactive, job_id=args.job_id,
                    worker_id=args.worker_id, worker_port=args.port,
                )
            except scraper_mod.InteractiveCancelException:
                print("[INFO] operator cancelled at Captcha solver checkpoint")
                _teardown(driver, gl)
                print("[RESULT] FAILED")
                return 1
            except Exception as exc:  # noqa: BLE001
                print(f"[ERROR] {channel_id}: enrichment crashed: {exc}", file=sys.stderr)
                result = {"ok": False, "fields": {}}

            if args.mode == "probe":
                _dump_probe(driver, scraper_mod, channel_id, interactive=args.interactive,
                            job_id=args.job_id, worker_port=args.port)
                continue

            if not result["ok"]:
                failed += 1
                print(f"[WARN] {channel_id}: enrichment failed", file=sys.stderr)
            elif args.dry_run:
                enriched += 1
                print(f"[DRY-RUN] {channel_id}: fields={json.dumps(result['fields'])}")
            else:
                write_enrichment(sb, t["id"], result["fields"])
                enriched += 1
                n_contacts = len([k for k in result["fields"] if k.endswith("_url") or k == "email"])
                print(f"[INFO] {channel_id}: enriched ({n_contacts} contact field(s))")

            time.sleep(YT_INTER_CHANNEL_DELAY_S)  # pace requests
    finally:
        _teardown(driver, gl)

    if args.mode == "probe":
        print("[RESULT] SUCCESS")
        return 0

    _write_summary(args.output, args.parent_job_id, attempted, enriched, failed)
    print(f"[DONE] YOUTUBE Phase 2 | attempted={attempted} enriched={enriched} failed={failed}")
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


def _dump_probe(driver, scraper_mod, channel_id: str, *, interactive: bool,
                job_id: str | None, worker_port: int) -> None:
    """Spike helper: print what the extraction found + raw signal so a future
    probe can confirm the parser still matches YouTube's markup. Also exercises
    the email reveal so we can see whether the reCAPTCHA gate clears."""
    print(f"\n===== PROBE {channel_id} =====")
    try:
        print(f"current_url = {driver.current_url}")
        print(f"title       = {driver.title!r}")
    except Exception as exc:  # noqa: BLE001
        print(f"(url/title unavailable: {exc})")
    try:
        html = driver.page_source or ""
    except Exception as exc:  # noqa: BLE001
        html = ""
        print(f"(page_source unavailable: {exc})")
    print(f"page_source length = {len(html)}")
    urls = _collect_about_urls(driver)
    print(f"----- collected About URLs ({len(urls)}) -----")
    for u in urls:
        print(f"  {u}  ->  {_unwrap_redirect(u)}")
    print("----- classified contact fields -----")
    print(json.dumps(classify_links(urls), indent=2, default=str))
    print("----- email reveal attempt -----")
    try:
        email, blocked = _attempt_email_reveal(
            driver, scraper_mod, interactive=interactive, job_id=job_id,
            worker_id=None, worker_port=worker_port,
        )
        print(f"email={email!r}  captcha_blocked={blocked}")
    except Exception as exc:  # noqa: BLE001
        print(f"(email reveal crashed: {exc})")
    print(f"===== END PROBE {channel_id} =====\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="YouTube channel contact enrichment (Phase 2)")
    parser.add_argument("profile_id", help="GoLogin profile ID (from gologin_profiles for the country)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["enrich", "probe"], default="enrich",
                        help="'enrich' (default) backfills DB; 'probe' dumps DOM for one --channel, no DB")
    parser.add_argument("--channel", default=None, help="(probe mode) single channel_id to dump")
    parser.add_argument("--parent-job-id", dest="parent_job_id", default=None,
                        help="Phase-1 scrape_queue.id whose channels to enrich")
    parser.add_argument("--top-n", dest="top_n", type=int, default=25,
                        help="Max channels to enrich this run (ranked by subscribers)")
    parser.add_argument("--job-id", dest="job_id", default=None,
                        help="This Phase-2 scrape_queue.id (for captcha checkpoints)")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--country-code", dest="country_code", default="",
                        help="ISO-2 of the (logged-in) profile — drives Google auto-login credential lookup")
    parser.add_argument("--requires-login", dest="requires_login", action="store_true",
                        help="Profile requires a Google login (escalate a challenge to the checkpoint)")
    parser.add_argument("--output", default="/tmp/youtube_phase2.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Checkpoint to noVNC on an unsolved reCAPTCHA instead of flagging blocked")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the browser + extraction but skip all DB writes")
    args = parser.parse_args()

    if args.mode == "probe" and not args.channel:
        print("[ERROR] --mode probe requires --channel", file=sys.stderr)
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

    # Share context with scraper.py's helpers (same mechanism as
    # kick_profile_scrape.py / scraper.py main()). country_code +
    # requires_google_login drive ensure_google_login_if_required's credential
    # lookup and challenge-escalation decision.
    scraper_mod._CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    scraper_mod._CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)
    scraper_mod._CAPTCHA_SOLVER_CTX["country_code"] = (args.country_code or "").strip().upper() or None
    scraper_mod._CAPTCHA_SOLVER_CTX["requires_google_login"] = bool(args.requires_login)

    rc = run(args, scraper_mod)
    sys.exit(rc)


if __name__ == "__main__":
    main()
