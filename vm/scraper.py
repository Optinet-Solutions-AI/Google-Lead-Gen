import os
import sys
import time
import json
import random
import argparse
import requests
import shutil
import zipfile
import base64
import re

from gologin import GoLogin
from urllib.parse import quote_plus, urlparse
from bs4 import BeautifulSoup

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# ---------------------------
# GoLogin connection
# ---------------------------
def connect_to_gologin_browser(debugger_address):
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_experimental_option("debuggerAddress", debugger_address)

    service = Service("/usr/local/bin/chromedriver")
    return webdriver.Chrome(service=service, options=chrome_options)

# ---------------------------
# Google consent handler
# ---------------------------
def accept_google_consent(driver):
    try:
        WebDriverWait(driver, 5).until(
            EC.element_to_be_clickable(
                (By.XPATH, "//button//div[contains(text(),'Accept')]")
            )
        ).click()
        time.sleep(2)
    except:
        pass


# ---------------------------
# Bing consent handler
# ---------------------------
def accept_bing_consent(driver):
    """
    Click Bing's cookie-consent accept button if it appears. Bing has
    cycled through several button IDs over the years and the label is
    localized — try the stable IDs first, then fall back to a text
    match across the major languages we scrape (en, de, it, da, no,
    fr, ar). Returns True if a button was clicked, False otherwise.

    The button MUST be clicked because the consent overlay covers
    `b_results` even after the container is in the DOM, leaving the
    parser with whatever vestigial element rendered behind the modal
    (typically just one placeholder — the symptom we've been seeing).
    """
    id_selectors = [
        (By.ID, "bnp_btn_accept"),
        (By.ID, "bnp_hfly_cta1"),
        (By.CSS_SELECTOR, "button#bnp_btn_accept"),
        (By.CSS_SELECTOR, "button.bnp_btn_accept"),
        (By.CSS_SELECTOR, "a#bnp_btn_accept"),
    ]
    for by, sel in id_selectors:
        try:
            btn = WebDriverWait(driver, 2).until(
                EC.element_to_be_clickable((by, sel))
            )
            btn.click()
            print(f"[INFO] Bing consent dismissed via selector: {sel}")
            time.sleep(1.5)
            return True
        except Exception:
            continue
    # Localized text fallback — covers EN, DE, IT, FR, ES, PT, DA, NO,
    # AR. Matches against any clickable <button> or <a>.
    try:
        btn = WebDriverWait(driver, 3).until(
            EC.element_to_be_clickable((
                By.XPATH,
                "//button[contains(., 'Accept') or contains(., 'Akzeptieren') or "
                "contains(., 'Accetta') or contains(., 'Aceptar') or "
                "contains(., 'Aceitar') or contains(., 'Acceptér') or "
                "contains(., 'Godta') or contains(., 'قبول') or "
                "contains(., 'I accept') or contains(., 'OK')] | "
                "//a[contains(., 'Accept') or contains(., 'Akzeptieren') or "
                "contains(., 'Accetta')]"
            ))
        )
        btn.click()
        print("[INFO] Bing consent dismissed via text match")
        time.sleep(1.5)
        return True
    except Exception:
        pass
    return False


def _maybe_save_bing_debug(page_source, url):
    """
    When BING_DEBUG=1 is set in the worker's env, dump the rendered
    page to /tmp so we can see exactly what Bing returned. This is the
    diagnostic that lets us tell apart consent-banner / interstitial /
    actual-but-empty / unusual-markup cases without guessing.
    """
    if os.environ.get("BING_DEBUG") != "1":
        return
    ts = int(time.time() * 1000)
    path = f"/tmp/bing_debug_{ts}.html"
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"<!-- URL: {url} -->\n")
            f.write(page_source)
        print(f"[DEBUG] Bing page_source saved to {path} ({len(page_source)} bytes)")
    except Exception as exc:
        print(f"[WARN] failed to save bing debug file: {exc}")

# ---------------------------
# Wait for Sponsored Results to appear (max 15 seconds) +
# scroll the SERP so lazy-loaded ads (lower on the page) actually
# render before we extract them. Manual browsing always scrolls a
# bit on initial page-load; matching that helps us see the same
# count of ads testers see when checking by hand.
# ---------------------------
def wait_for_sponsored_results(driver, timeout=15):
    try:
        WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((By.XPATH, '//span[text()="Sponsored results"]'))
        )
        print("[DEBUG] Sponsored results section is now visible.")
    except Exception:  # noqa: BLE001
        print("[INFO] Sponsored results section not found within timeout.")

    # Scroll-and-settle so any below-the-fold ad blocks load before
    # extract_sponsored_urls_selenium runs. Cheap (one second total).
    try:
        driver.execute_script(
            "window.scrollTo(0, document.body.scrollHeight); "
            "setTimeout(() => window.scrollTo(0, 0), 0);"
        )
        time.sleep(1.0)
    except Exception:  # noqa: BLE001
        pass

# ---------------------------
# Extract Sponsored URLs using Selenium
# ---------------------------
def extract_sponsored_urls_selenium(driver):
    """Returns a dict { ppc_url: anchor_element } so the caller can both
    enumerate sponsored URLs AND screenshot the corresponding ad cards.
    """
    sponsored: dict = {}

    try:
        print("[DEBUG] Searching for 'Sponsored results' sections...")
        sponsored_sections = driver.find_elements(
            By.XPATH, '//span[text()="Sponsored results"]/ancestor::div[@jscontroller]'
        )
        print(f"[DEBUG] Found {len(sponsored_sections)} 'Sponsored results' sections.")

        for section in sponsored_sections:
            a_tags = section.find_elements(By.CSS_SELECTOR, 'a[data-pcu], a[href]')
            print(f"[DEBUG] Found {len(a_tags)} ad links inside this section.")
            for a in a_tags:
                raw_url = a.get_attribute("data-pcu") or a.get_attribute("href")
                url = raw_url.split(",")[0] if raw_url else None
                if url and url.startswith("http") and url not in sponsored:
                    sponsored[url] = a
                    print(f"[DEBUG] Detected PPC URL: {url}")

        fallback_links = driver.find_elements(By.CSS_SELECTOR, 'a[data-pcu]')
        print(f"[DEBUG] Found {len(fallback_links)} fallback ad links.")
        for a in fallback_links:
            raw_url = a.get_attribute("data-pcu")
            url = raw_url.split(",")[0] if raw_url else None
            if url and url.startswith("http") and url not in sponsored:
                sponsored[url] = a
                print(f"[DEBUG] Detected fallback PPC URL: {url}")

    except Exception as e:
        print(f"[WARN] PPC extraction failed: {e}", file=sys.stderr)

    print(f"[INFO] Detected {len(sponsored)} PPC URLs")
    return sponsored


def capture_serp_card_screenshot(driver, anchor, out_path: str) -> bool:
    """Snap a PNG of the ad card on the SERP itself — what the searcher
    actually saw — before any click-through cloaker fight.

    Deterministic and ~100% reliable: the anchor is already in the DOM,
    so we just walk up to the nearest ad-card ancestor, scroll it into
    view, and call WebElement.screenshot_as_png. No redirect chain, no
    new tab, no waiting on third-party JS.

    Replaces the click-through landing-page screenshot which has been
    silently failing on >96% of PPC leads since the 2026-05-07 rewrite
    (cloakers gate the click on bot signals and refuse to settle).

    Returns True on success, False on any failure. Never raises —
    failure here must not block the rest of the scrape.
    """
    try:
        # Walk up to the closest ad-card ancestor. Google's class names
        # are obfuscated and rotate, so try several known wrappers in
        # priority order and fall back to "first reasonably-sized
        # ancestor". Anything taller than 60px is almost certainly the
        # card and not just the title line.
        card = None
        candidates = (
            "./ancestor::div[@data-text-ad][1]",
            "./ancestor::div[@jscontroller and contains(@class, 'uEierd')][1]",
            "./ancestor::div[@jscontroller][2]",
            "./ancestor::div[@jscontroller][1]",
        )
        for xpath in candidates:
            try:
                el = anchor.find_element(By.XPATH, xpath)
                if el.size.get("height", 0) >= 60:
                    card = el
                    break
            except Exception:  # noqa: BLE001
                continue
        if card is None:
            card = anchor

        # scrollIntoView gives any deferred ad-network JS a chance to
        # paint before we snap. block:'center' avoids the sticky header
        # clipping the top of the card.
        driver.execute_script(
            "arguments[0].scrollIntoView({block: 'center', behavior: 'instant'});",
            card,
        )
        time.sleep(0.4)

        png = card.screenshot_as_png
        with open(out_path, "wb") as fh:
            fh.write(png)
        print(f"[DEBUG] Saved SERP ad-card screenshot: {out_path}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] SERP ad-card screenshot failed: {exc}", file=sys.stderr)
        return False


def click_through_ppc(driver, anchor, screenshot_path: str | None) -> tuple[str | None, bool]:
    """Click through a PPC ad as if a real user did it: real Ctrl+Click
    on the anchor (so the destination sees a true user-gesture click,
    not a scripted window.open — many cloakers gate on that), wait up
    to 15s for the redirect chain to settle and the DOM to finish
    loading, **scroll to the bottom + back to the top** so lazy-loaded
    sections render, then take a full-page CDP screenshot of the
    uncloaked landing page. Close the tab, return to the SERP.

    Returns (full_url, screenshot_taken). Either field is None / False
    on failure; failure never blocks the scrape.

    Why all of this:
      - Ctrl+Click instead of window.open: cloakers often check for a
        real `MouseEvent` with `isTrusted=true`. A scripted window.open
        fails that check and gets the bare-domain "safe" page.
      - 15s settle window: some ad-network → tracker → landing-page
        chains take 8-12s. The previous 6s cap was cutting them off.
      - Full-page screenshot via CDP `Page.captureScreenshot` with
        `captureBeyondViewport=true`: Selenium's element_screenshot is
        viewport-only, so longer pages got truncated at the fold. CDP
        renders the entire scrollHeight in one shot.
      - Scroll-to-bottom-then-top before the screenshot: lazy-loaded
        images / iframes / third-party widgets only resolve once the
        viewport reaches them. We do this synchronously so the final
        screenshot has actual content, not skeleton placeholders.
    """
    from selenium.webdriver.common.keys import Keys

    href = anchor.get_attribute("href")
    if not href:
        return None, False

    original_handle = driver.current_window_handle
    new_handle = None
    try:
        before_handles = set(driver.window_handles)

        # Real Ctrl+Click via send_keys → fires a user-gesture click
        # that opens the destination in a new tab. Falls back to
        # window.open only if the anchor refuses to receive keys
        # (rare; sometimes happens on stale DOM).
        opened = False
        try:
            anchor.send_keys(Keys.CONTROL + Keys.ENTER)
            opened = True
        except Exception:  # noqa: BLE001
            pass
        if not opened:
            try:
                driver.execute_script("window.open(arguments[0], '_blank');", href)
                opened = True
            except Exception:  # noqa: BLE001
                opened = False
        if not opened:
            print("[WARN] PPC click-through: could not open new tab", file=sys.stderr)
            return None, False

        # Selenium needs a beat for the new window to register.
        time.sleep(0.6)

        new_handles = [h for h in driver.window_handles if h not in before_handles]
        if not new_handles:
            print("[WARN] PPC click-through: new tab never appeared", file=sys.stderr)
            return None, False
        new_handle = new_handles[-1]
        driver.switch_to.window(new_handle)

        # Poll until URL stops changing AND has left Google's redirect
        # domains AND document is loaded. 15s cap (was 6s — too short
        # for some uncloak chains).
        prev = ""
        final = None
        for _ in range(30):  # 30 * 0.5 = 15s
            time.sleep(0.5)
            try:
                cur = driver.current_url
                ready = driver.execute_script("return document.readyState") == "complete"
            except Exception:  # noqa: BLE001
                cur = ""
                ready = False
            if not cur:
                continue
            on_redirect = (
                "googleadservices.com" in cur
                or "doubleclick.net" in cur
                or "google.com/aclk" in cur
            )
            if cur == prev and not on_redirect and ready:
                final = cur
                break
            prev = cur
        # Fall back to whatever current_url is if we never settled.
        if not final:
            try:
                final = driver.current_url
            except Exception:  # noqa: BLE001
                final = None

        # ----- Full-page screenshot of the uncloaked landing page -----
        screenshot_taken = False
        if screenshot_path and final and final.startswith("http"):
            try:
                # Trigger lazy-loaded content by scrolling to the bottom
                # (in chunks, with small pauses so observers fire), then
                # snap back to the top before the screenshot so the hero
                # section shows up at the top of the captured image.
                driver.execute_script(
                    """
                    return new Promise(resolve => {
                        const step = 600;
                        let y = 0;
                        const max = document.body.scrollHeight || 8000;
                        const tick = setInterval(() => {
                            window.scrollBy(0, step);
                            y += step;
                            if (y >= max) {
                                clearInterval(tick);
                                window.scrollTo(0, 0);
                                setTimeout(resolve, 250);
                            }
                        }, 120);
                    });
                    """,
                )
                # Give lazy iframes / images one more beat to settle.
                time.sleep(1.2)

                # CDP full-page screenshot — captures the entire scroll
                # height in one PNG, no manual stitching.
                cdp = driver.execute_cdp_cmd(
                    "Page.captureScreenshot",
                    {"captureBeyondViewport": True, "fromSurface": True},
                )
                import base64
                png_bytes = base64.b64decode(cdp["data"])
                with open(screenshot_path, "wb") as fh:
                    fh.write(png_bytes)
                screenshot_taken = True
                print(f"[DEBUG] Saved PPC landing screenshot: {screenshot_path} (url={final})")
            except Exception as exc:  # noqa: BLE001
                print(f"[WARN] PPC landing screenshot failed: {exc}", file=sys.stderr)

        if final and final.startswith("http"):
            return final, screenshot_taken
        return None, screenshot_taken
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] PPC click-through failed: {exc}", file=sys.stderr)
        return None, False
    finally:
        # Always close the new tab + return to the SERP, even on error.
        try:
            if new_handle and driver.current_window_handle == new_handle:
                driver.close()
            if driver.current_window_handle != original_handle:
                driver.switch_to.window(original_handle)
        except Exception:  # noqa: BLE001
            pass

# ---------------------------
# Helper: extract domain from URL
# ---------------------------
def get_domain(url):
    parsed = urlparse(url)
    domain = parsed.netloc.lower()
    if domain.startswith("www."):
        domain = domain[4:]
    return domain

# ---------------------------
# Deduplicate results by (domain, resultType)
# ---------------------------
# Dedupe keys on resultType so a domain that appears as both a PPC ad and an
# Organic hit keeps both rows. Per-URL overlap across desktop/mobile is already
# collapsed by the seen_on merge in scrape_google_search before this runs, so
# the remaining same-domain entries are either multi-page repeats (collapse OK)
# or distinct PPC/Organic surfaces (keep both).
def deduplicate_results(results):
    seen = set()
    cleaned_results = []

    for r in results:
        domain = get_domain(r["url"])
        key = (domain, r.get("resultType"))
        if key not in seen:
            seen.add(key)
            cleaned_results.append(r)
        else:
            print(f"[DEBUG] Skipping duplicate {key[1]} on domain: {domain}")

    return cleaned_results

# ---------------------------
# Login-state detection
# ---------------------------
def detect_login_state(driver):
    """
    Sniff the currently loaded Google page for sign-in indicators.

    Returns:
      True   — a Google account is signed in
      False  — the profile is signed OUT (sign-in CTA visible)
      None   — indeterminate (CAPTCHA, error page, or markup we don't recognise)
    """
    try:
        source = driver.page_source
    except Exception as exc:
        print(f"[WARN] login-state: page_source unavailable: {exc}", file=sys.stderr)
        return None

    # Logged-in signals (specific to an active account on Google)
    logged_in_signals = (
        'aria-label="Google Account',          # account avatar tooltip
        'myaccount.google.com',                # account dashboard link
    )
    # Logged-out signal — the explicit "Sign in" CTA points at ServiceLogin
    logged_out_signals = (
        'accounts.google.com/ServiceLogin',
    )

    has_logged_in  = any(s in source for s in logged_in_signals)
    has_logged_out = any(s in source for s in logged_out_signals)

    if has_logged_in and not has_logged_out:
        return True
    if has_logged_out and not has_logged_in:
        return False
    if has_logged_in and has_logged_out:
        # Both signals present → trust the more specific logged-in one
        return True
    return None

# ---------------------------
# CAPTCHA exception
# ---------------------------
class CaptchaDetectedException(Exception):
    pass

# ---------------------------
# CAPTCHA checker
# ---------------------------
# Human-in-the-loop interactive checkpoints
# ---------------------------
# When the scraper hits a wall (captcha, age verification, cookie banner)
# AND --interactive is on, instead of failing the job we:
#   1. Snap a viewport screenshot, upload to lead-screenshots bucket
#   2. Insert a row into interactive_checkpoints via RPC
#   3. Flip scrape_queue.status to 'needs_human' (RPC does this for us)
#   4. Poll scrape_queue.status every 5s until it flips back to 'running'
#      (operator clicked Resume) or 'failed'/'cancelled' (Cancel) or
#      we hit the TTL (default 15 min).
# The Chromium tab stays open the whole time so the operator's clicks
# in the noVNC viewer affect the same session.

CHECKPOINT_POLL_SECONDS = 5
# Hard fallback when system_settings is unreachable. Matches the live
# seed value (5 min, set by an earlier migration in 20260522010000).
# The worker reads the live value out of system_settings.captcha_solver_ttl_minutes
# for each checkpoint so an admin can tune it via /admin/system without
# restarting workers; this constant only kicks in if the DB lookup fails.
CHECKPOINT_DEFAULT_TTL_MINUTES = 5

# Result markers the worker greps for after the scraper subprocess exits.
# Distinct from the generic CAPTCHA marker (which triggers auto-retry via
# captcha_scrape_job) so Captcha solver timeouts can be routed to a terminal-only
# path — operators manually re-queue from /admin/interactive when ready,
# instead of the worker cycling the same captcha 10 times in 20 minutes.
RESULT_MARKER_CAPTCHA_SOLVER_TIMEOUT = "[RESULT] CAPTCHA_SOLVER_TIMEOUT"


def _fetch_captcha_solver_ttl_minutes() -> int:
    """Pull the live TTL from system_settings via the service-role RPC
    we already use elsewhere. Falls back to CHECKPOINT_DEFAULT_TTL_MINUTES
    if the row is missing or the value isn't a positive int."""
    try:
        resp = _supabase_request(
            "POST",
            "/rest/v1/rpc/get_system_setting",
            json_body={"p_key": "captcha_solver_ttl_minutes"},
        )
        if resp.status_code != 200:
            return CHECKPOINT_DEFAULT_TTL_MINUTES
        val = resp.json()
        # The RPC returns the jsonb value directly. We accept either a
        # raw number (`2`) or a stringified number (`"2"`).
        if isinstance(val, bool):  # bool is a subclass of int — explicit reject
            return CHECKPOINT_DEFAULT_TTL_MINUTES
        if isinstance(val, (int, float)):
            n = int(val)
        elif isinstance(val, str):
            n = int(val.strip())
        else:
            return CHECKPOINT_DEFAULT_TTL_MINUTES
        return n if n > 0 else CHECKPOINT_DEFAULT_TTL_MINUTES
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] captcha_solver_ttl_minutes lookup failed: {exc} — using default {CHECKPOINT_DEFAULT_TTL_MINUTES}m",
              file=sys.stderr)
        return CHECKPOINT_DEFAULT_TTL_MINUTES


def _fetch_captcha_auto_solve_enabled() -> bool:
    """Live read of the `captcha_auto_solve` flag from system_settings.

    Gates the automated 2Captcha solver independently of the manual
    noVNC flow (`captcha_solver_enabled`). Read at the moment we hit a
    wall — flipping it from /admin/system takes effect on the next
    captcha without a worker restart.

    Fails CLOSED (returns False) on any lookup error: we never want a
    transient DB blip to start spending 2Captcha credits unexpectedly,
    and False just means "behave as before".
    """
    try:
        resp = _supabase_request(
            "POST",
            "/rest/v1/rpc/get_system_setting",
            json_body={"p_key": "captcha_auto_solve"},
        )
        if resp.status_code != 200:
            return False
        val = resp.json()
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.strip().lower() == "true"
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] captcha_auto_solve lookup failed: {exc} — treating as OFF",
              file=sys.stderr)
        return False


# Set by main() at startup. check_for_captcha falls back to these
# when callers don't pass kwargs explicitly. Keeps existing
# `check_for_captcha(driver)` callsites working unchanged.
#
# country_code + requires_google_login carry the per-country context
# that ensure_google_login_if_required() needs to look up credentials
# in the google_login_credentials table and decide whether a missing
# login should escalate to the Captcha solver.
_CAPTCHA_SOLVER_CTX: dict = {
    "job_id": None,
    "worker_id": None,
    "worker_port": 9222,
    "interactive": False,
    "country_code": None,
    "requires_google_login": False,
}

class InteractiveCancelException(Exception):
    """Operator clicked Cancel in the dashboard. Job is already marked
    failed; the scraper exits gracefully."""
    pass


def _supabase_request(method: str, path: str, *, json_body=None, headers=None):
    """Lightweight Supabase REST call using requests + service role key.
    Avoids pulling the full supabase-py client into the scraper just for
    a couple of one-shot calls."""
    import requests as _rq
    base = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in env")
    url = f"{base.rstrip('/')}{path}"
    h = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        **(headers or {}),
    }
    resp = _rq.request(method, url, headers=h, json=json_body, timeout=30)
    return resp


def _upload_checkpoint_screenshot(driver, job_id: str) -> str | None:
    """Snap a viewport-only screenshot of the current page and upload
    it to the lead-screenshots Storage bucket. Returns the bucket-
    relative path on success, None on any failure (best-effort)."""
    try:
        png = driver.get_screenshot_as_png()
        if not png:
            return None
        path = f"interactive/{job_id}/{int(time.time() * 1000)}.png"
        resp = _supabase_request(
            "POST",
            f"/storage/v1/object/lead-screenshots/{path}",
            headers={"Content-Type": "image/png"},
        )
        # The above won't accept binary via json_body. Use a raw POST.
        import requests as _rq
        base = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        resp = _rq.post(
            f"{base}/storage/v1/object/lead-screenshots/{path}",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "image/png",
                "x-upsert": "true",
            },
            data=png,
            timeout=30,
        )
        if 200 <= resp.status_code < 300:
            return path
        print(f"[WARN] checkpoint screenshot upload failed: {resp.status_code} {resp.text[:200]}",
              file=sys.stderr)
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] checkpoint screenshot capture failed: {exc}", file=sys.stderr)
        return None


def request_interactive_checkpoint(
    driver,
    *,
    job_id: str | None,
    worker_id: str | None,
    worker_port: int,
    reason: str,
    ttl_minutes: int | None = None,
) -> bool:
    """Pause the scrape and wait for an admin to resolve via noVNC.

    Returns True when the operator clicked Resume — the caller should
    re-check the page state and continue. Returns False when the TTL
    elapsed without operator action. Raises InteractiveCancelException
    when the operator clicked Cancel.

    On TTL elapse this function flips the checkpoint row to 'timed_out'
    via the timeout RPC but does NOT emit RESULT_MARKER_CAPTCHA_SOLVER_TIMEOUT —
    that's the caller's job, so the refresh-loop wrapper can re-park
    without prematurely routing the worker to the terminal path.

    Requires --interactive + --job-id + --worker-id to actually fire;
    when called without them, returns False immediately so legacy
    callers fall through to their existing fail path.

    TTL: passing None (default) reads system_settings.captcha_solver_ttl_minutes
    so an admin can tune via /admin/system without restarting workers.
    Pass an explicit int to override per-call (tests etc.).
    """
    if not job_id:
        print("[INFO] checkpoint: no --job-id, skipping (interactive flag ignored)")
        return False

    if ttl_minutes is None:
        ttl_minutes = _fetch_captcha_solver_ttl_minutes()

    print(f"[INFO] checkpoint: pausing for human (reason={reason}, ttl={ttl_minutes}m)")

    # Maximize the Chromium window so the noVNC viewer shows the captcha
    # full-screen instead of buried in a small window the operator has
    # to hunt for. Per-worker Xvfb isolation already shows only this
    # worker's browser; maximize takes that the last 10 ft.
    try:
        driver.maximize_window()
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] checkpoint: maximize_window failed: {exc}", file=sys.stderr)

    try:
        current_url = driver.current_url or None
    except Exception:  # noqa: BLE001
        current_url = None
    try:
        page_title = driver.title or None
    except Exception:  # noqa: BLE001
        page_title = None

    screenshot_path = _upload_checkpoint_screenshot(driver, job_id)

    # Insert the checkpoint row + flip scrape_queue status to needs_human.
    # VM_PUBLIC_HOST tells the dashboard which VM to route Open-VNC to;
    # required once we run more than one worker box. NULL falls back to
    # the dashboard's NEXT_PUBLIC_VNC_BASE_URL env var.
    vnc_host = os.environ.get("VM_PUBLIC_HOST") or None
    checkpoint_id: int | None = None
    try:
        resp = _supabase_request(
            "POST",
            "/rest/v1/rpc/create_interactive_checkpoint",
            json_body={
                "p_job_id": job_id,
                "p_worker_id": worker_id or "unknown",
                "p_worker_port": worker_port,
                "p_reason": reason,
                "p_current_url": current_url,
                "p_page_title": page_title,
                "p_screenshot_path": screenshot_path,
                "p_ttl_minutes": ttl_minutes,
                "p_vnc_host": vnc_host,
            },
        )
        if resp.status_code >= 300:
            print(f"[ERROR] checkpoint create failed: {resp.status_code} {resp.text[:200]}",
                  file=sys.stderr)
            return False
        try:
            checkpoint_id = int(resp.json())
        except Exception:  # noqa: BLE001
            checkpoint_id = None
        print(f"[INFO] checkpoint created: id={checkpoint_id}")
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] checkpoint create raised: {exc}", file=sys.stderr)
        return False

    # Poll scrape_queue.status until it flips back to 'running' (resumed)
    # or 'failed'/'cancelled' (cancelled) or our TTL expires.
    deadline = time.time() + ttl_minutes * 60
    while time.time() < deadline:
        time.sleep(CHECKPOINT_POLL_SECONDS)
        try:
            resp = _supabase_request(
                "GET",
                f"/rest/v1/scrape_queue?id=eq.{job_id}&select=status",
            )
            if resp.status_code != 200:
                continue
            data = resp.json()
            if not data:
                continue
            status = data[0].get("status", "")
            if status == "running":
                print("[INFO] checkpoint resolved by operator — resuming scrape")
                return True
            if status in ("failed", "cancelled"):
                print(f"[INFO] checkpoint cancelled (status={status}) — exiting")
                raise InteractiveCancelException(f"operator cancelled at checkpoint: {status}")
            # status == 'needs_human' — keep waiting
        except InteractiveCancelException:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] checkpoint poll error: {exc}", file=sys.stderr)

    print(f"[WARN] checkpoint timed out without operator action ({ttl_minutes}m elapsed)")

    # Flip the checkpoint row to 'timed_out' so /admin/interactive can
    # render a "Re-queue with Captcha solver" button on it. Idempotent — the RPC
    # only updates rows still in 'waiting' state.
    if checkpoint_id is not None:
        try:
            _supabase_request(
                "POST",
                "/rest/v1/rpc/timeout_interactive_checkpoint",
                json_body={"p_id": checkpoint_id},
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] timeout_interactive_checkpoint RPC failed: {exc}",
                  file=sys.stderr)

    # Caller (refresh-loop wrapper) decides whether this timeout means
    # "try another cycle" or "all attempts exhausted — emit the
    # RESULT_MARKER_CAPTCHA_SOLVER_TIMEOUT and let worker.py go terminal".
    return False


# Default cap on Captcha solver park cycles before we give up and route the job
# to the terminal path. 10 × 5min = 50 min ceiling per stuck captcha.
# Matches the existing captcha auto-retry cap for symmetry.
CHECKPOINT_MAX_REFRESH_ATTEMPTS = 10
# Settle time after driver.refresh() before re-probing the page state.
# Long enough for Cloudflare/Google challenge scripts to mount; short
# enough that the operator's wait time isn't padded.
CHECKPOINT_POST_REFRESH_SETTLE_S = 4.0


def _request_interactive_checkpoint_with_refresh(
    driver,
    *,
    job_id: str | None,
    worker_id: str | None,
    worker_port: int,
    reason: str,
    is_still_blocked,
    ttl_minutes: int | None = None,
    max_attempts: int = CHECKPOINT_MAX_REFRESH_ATTEMPTS,
    post_refresh_settle_s: float = CHECKPOINT_POST_REFRESH_SETTLE_S,
) -> bool:
    """Park at a Captcha solver checkpoint with auto-refresh + re-park.

    Up to max_attempts park cycles. Between cycles, driver.refresh() is
    called and is_still_blocked() is re-checked — a refresh that happens
    to clear the wall returns True without burning another operator slot.

    Returns True when the page is clear (operator solved OR a refresh
    cleared it). Returns False after exhausting max_attempts; emits
    RESULT_MARKER_CAPTCHA_SOLVER_TIMEOUT before returning so worker.py routes the
    job to the terminal path.

    InteractiveCancelException (operator clicked Cancel) propagates
    immediately — explicit cancel is not retried.
    """
    if not job_id:
        # Same short-circuit as the underlying function — caller falls
        # through to its existing fail path.
        return False

    def _still_blocked() -> bool:
        # Transient Selenium errors from the page-state probe (stale
        # element refs during navigation, etc.) shouldn't crash the
        # loop. Treat any exception as "still blocked" so we re-park
        # rather than falsely returning success.
        try:
            return bool(is_still_blocked())
        except Exception as exc:  # noqa: BLE001
            print(
                f"[WARN] checkpoint: is_still_blocked() raised: {exc} — assuming blocked",
                file=sys.stderr,
            )
            return True

    for attempt in range(1, max_attempts + 1):
        resumed = request_interactive_checkpoint(
            driver,
            job_id=job_id,
            worker_id=worker_id,
            worker_port=worker_port,
            reason=reason,
            ttl_minutes=ttl_minutes,
        )
        # InteractiveCancelException from an operator click propagates
        # out untouched — explicit cancel is not retried.

        if resumed and not _still_blocked():
            if attempt > 1:
                print(f"[INFO] checkpoint: cleared after {attempt} attempt(s)")
            return True

        if attempt >= max_attempts:
            print(
                f"[WARN] checkpoint: exhausted {max_attempts} refresh attempts "
                f"({reason!r}) — giving up",
                file=sys.stderr,
            )
            print(RESULT_MARKER_CAPTCHA_SOLVER_TIMEOUT)
            return False

        why = "operator resumed but page still blocked" if resumed else "TTL elapsed"
        print(
            f"[INFO] checkpoint: {why} (attempt {attempt}/{max_attempts}) "
            f"— refreshing browser and re-parking"
        )
        try:
            driver.refresh()
            time.sleep(post_refresh_settle_s)
        except Exception as exc:  # noqa: BLE001
            print(
                f"[WARN] checkpoint: driver.refresh() failed: {exc}",
                file=sys.stderr,
            )

        # A refresh can clear the wall on its own (e.g. Cloudflare lets
        # the new request through). Skip the next park if so.
        if not _still_blocked():
            print("[INFO] checkpoint: refresh alone cleared the blocker — resuming scrape")
            return True

    return False  # unreachable — exhaustion branch above returns False


# ---------------------------
# Google auto-login (per-country credentials from DB + Captcha solver fallback)
# ---------------------------
# When a GoLogin profile rotates IPs aggressively, Google server-side
# invalidates the session. We detect that on startup, fetch encrypted
# credentials from public.google_login_credentials via service-role RPC,
# and drive the sign-in form. If Google throws 2FA / verify-it's-you /
# captcha mid-login, we escalate to a Captcha solver checkpoint with reason
# 'google_login_required' so an operator can finish via noVNC.

def fetch_google_login_credential(country_code):
    """Fetch the active credential for a country. Returns
    {'email': str, 'password': str} or None."""
    if not country_code:
        return None
    try:
        resp = _supabase_request(
            "POST",
            "/rest/v1/rpc/get_google_login_credential",
            json_body={"p_country_code": country_code},
        )
        if resp.status_code != 200:
            print(f"[INFO] google login: no creds RPC ok for {country_code} (HTTP {resp.status_code})")
            return None
        data = resp.json()
        if not data:
            return None
        row = data[0] if isinstance(data, list) else data
        email = row.get("email")
        password = row.get("password")
        if email and password:
            return {"email": email, "password": password}
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] google login: credential fetch failed: {exc}", file=sys.stderr)
        return None


def mark_google_login_used(country_code, status):
    """Best-effort stamp of last-used metadata on the active credential."""
    if not country_code:
        return
    try:
        _supabase_request(
            "POST",
            "/rest/v1/rpc/mark_google_login_used",
            json_body={"p_country_code": country_code, "p_status": status},
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] google login: mark_used failed: {exc}", file=sys.stderr)


def _login_has_challenge(driver):
    """Detect 2FA / verify-it's-you / captcha on the login page."""
    try:
        cur = (driver.current_url or "").lower()
    except Exception:  # noqa: BLE001
        cur = ""
    challenge_url_markers = (
        "/signin/v2/challenge", "/signin/challenge",
        "/signin/recaptcha", "/signin/v2/sl/challenge",
        "/deniedsigninrejected", "/signin/usagecaptcha",
    )
    if any(m in cur for m in challenge_url_markers):
        return True
    try:
        page = (driver.page_source or "").lower()
    except Exception:  # noqa: BLE001
        page = ""
    challenge_text_markers = (
        "verify it’s you", "verify it's you",
        "2-step verification", "two-step verification",
        "g.co/verifyaccount", "recaptcha",
        "unusual sign-in", "unusual activity",
        "couldn’t sign you in", "couldn't sign you in",
    )
    return any(m in page for m in challenge_text_markers)


def attempt_google_login(driver, email, password):
    """
    Drive Google's sign-in form. Returns:
      'success'   — landed on google.com / myaccount.google.com after login
      'challenge' — Google asked for 2FA / verify-it's-you / captcha
      'failed'    — wrong password / blocked / unknown error
    """
    print(f"[INFO] google login: attempting auto sign-in as {email}")
    try:
        driver.get(
            "https://accounts.google.com/ServiceLogin"
            "?continue=https%3A%2F%2Fwww.google.com%2F&hl=en"
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] google login: navigation failed: {exc}", file=sys.stderr)
        return "failed"

    # Email step ------------------------------------------------------------
    try:
        email_input = WebDriverWait(driver, 15).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[type="email"]'))
        )
        email_input.clear()
        for ch in email:
            email_input.send_keys(ch)
            time.sleep(random.uniform(0.04, 0.14))
        try:
            driver.find_element(By.ID, "identifierNext").click()
        except Exception:  # noqa: BLE001
            email_input.send_keys(Keys.RETURN)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] google login: email step failed: {exc}", file=sys.stderr)
        if _login_has_challenge(driver):
            return "challenge"
        return "failed"

    time.sleep(2.5)
    if _login_has_challenge(driver):
        return "challenge"

    # Password step ---------------------------------------------------------
    try:
        password_input = WebDriverWait(driver, 12).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[type="password"]'))
        )
        password_input.clear()
        for ch in password:
            password_input.send_keys(ch)
            time.sleep(random.uniform(0.04, 0.14))
        try:
            driver.find_element(By.ID, "passwordNext").click()
        except Exception:  # noqa: BLE001
            password_input.send_keys(Keys.RETURN)
    except Exception as exc:  # noqa: BLE001
        # No password input usually means: account-not-found, deny page,
        # or a challenge interstitial.
        if _login_has_challenge(driver):
            return "challenge"
        print(f"[WARN] google login: password step failed: {exc}", file=sys.stderr)
        return "failed"

    # Wait for the post-login redirect --------------------------------------
    deadline = time.time() + 25
    while time.time() < deadline:
        time.sleep(1.5)
        try:
            cur = driver.current_url or ""
        except Exception:  # noqa: BLE001
            cur = ""
        if "myaccount.google.com" in cur or cur.startswith("https://www.google.com/"):
            time.sleep(1.0)
            return "success"
        if _login_has_challenge(driver):
            return "challenge"

    # Final state check
    try:
        cur = driver.current_url or ""
    except Exception:  # noqa: BLE001
        cur = ""
    if "myaccount.google.com" in cur or cur.startswith("https://www.google.com/"):
        return "success"
    if _login_has_challenge(driver):
        return "challenge"
    return "failed"


def _request_login_checkpoint(driver):
    """Park the scrape at a Captcha solver checkpoint with reason='google_login_required'.
    Auto-refreshes + re-parks up to CHECKPOINT_MAX_REFRESH_ATTEMPTS times if
    the operator times out or finishes but the profile isn't signed in yet.
    Returns True if the operator finished the login and the profile is now
    signed in, False otherwise. Raises InteractiveCancelException on cancel."""
    if not _CAPTCHA_SOLVER_CTX.get("interactive") or not _CAPTCHA_SOLVER_CTX.get("job_id"):
        print("[WARN] google login: Captcha solver disabled, continuing without login",
              file=sys.stderr)
        return False
    country_code = _CAPTCHA_SOLVER_CTX.get("country_code")
    cleared = _request_interactive_checkpoint_with_refresh(
        driver,
        job_id=_CAPTCHA_SOLVER_CTX.get("job_id"),
        worker_id=_CAPTCHA_SOLVER_CTX.get("worker_id"),
        worker_port=_CAPTCHA_SOLVER_CTX.get("worker_port", 9222),
        reason="google_login_required",
        is_still_blocked=lambda: detect_login_state(driver) is not True,
    )
    if not cleared:
        mark_google_login_used(country_code, "checkpoint_unresolved")
        return False
    # Helper verified detect_login_state is True at the moment of return.
    # Re-check defensively in case state flipped during the brief window.
    new_state = detect_login_state(driver)
    if new_state is True:
        mark_google_login_used(country_code, "checkpoint_success")
        return True
    mark_google_login_used(country_code, "checkpoint_unverified")
    return False


def ensure_google_login_if_required(driver):
    """
    Run this once after the connectivity check, before the first search.

    Decision tree:
      1. Land on google.com (so detect_login_state has signal).
      2. detect_login_state(driver) → True ⇒ already signed in, return.
      3. Logged-out + creds in DB ⇒ run attempt_google_login.
         - 'success'   → stamp + return.
         - 'challenge' → escalate to the Captcha solver.
         - 'failed'    → stamp; if country requires login, escalate to the Captcha solver,
                         otherwise continue best-effort.
      4. Logged-out + NO creds ⇒ if country requires login, escalate to the Captcha solver,
         otherwise continue without login.
    """
    country_code = _CAPTCHA_SOLVER_CTX.get("country_code")
    requires_login = bool(_CAPTCHA_SOLVER_CTX.get("requires_google_login"))

    try:
        cur = driver.current_url or ""
    except Exception:  # noqa: BLE001
        cur = ""
    if "google.com" not in cur:
        try:
            # ?hl=en forces English UI so a German-proxy captcha doesn't
            # render in German (operators can't read it).
            driver.get("https://www.google.com/?hl=en")
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] google login: nav to google.com failed: {exc}",
                  file=sys.stderr)
            return

    # Dismiss the consent overlay so detect_login_state can read the page.
    accept_google_consent(driver)

    state = detect_login_state(driver)
    if state is True:
        print(f"[INFO] google login: profile already signed in (country={country_code})")
        return
    if state is None and not requires_login:
        print(f"[INFO] google login: state indeterminate; country={country_code} doesn't require login — skipping")
        return

    print(f"[INFO] google login: signed-out detected (country={country_code}, requires={requires_login})")

    creds = fetch_google_login_credential(country_code)
    if creds:
        outcome = attempt_google_login(driver, creds["email"], creds["password"])
        if outcome == "success":
            mark_google_login_used(country_code, "success")
            # Reset to a clean google.com so the rest of the scrape
            # doesn't navigate from inside the accounts.google.com domain.
            # ?hl=en keeps the UI in English regardless of proxy geo.
            try:
                driver.get("https://www.google.com/?hl=en")
            except Exception:  # noqa: BLE001
                pass
            return
        if outcome == "challenge":
            mark_google_login_used(country_code, "challenge")
            _request_login_checkpoint(driver)
            return
        # outcome == 'failed'
        mark_google_login_used(country_code, "failed_login")
        if requires_login:
            _request_login_checkpoint(driver)
        return

    # No creds available -----------------------------------------------------
    if requires_login:
        print(f"[INFO] google login: no creds for {country_code} — escalating to the Captcha solver")
        _request_login_checkpoint(driver)
    else:
        print(f"[INFO] google login: no creds for {country_code} — continuing without login")


# ---------------------------
# Automated 2Captcha solver
# ---------------------------
# Paid external service (https://2captcha.com) that solves reCAPTCHA v2
# (Google /sorry/) and Cloudflare Turnstile (Bing) by returning a token
# we inject into the page. Gated by BOTH:
#   1. TWOCAPTCHA_API_KEY present in the VM's ~/.env, AND
#   2. the live system_settings flag `captcha_auto_solve` == true
# so we never spend credits unless an operator explicitly enabled it.
#
# HONEST CAVEAT: the token-injection + submit step is the fragile part.
# Google /sorry/ binds reCAPTCHA tokens to the originating IP, and
# Cloudflare's managed Turnstile sometimes needs an `action`/`cdata`
# pair we can't always read from the DOM. Treat a failed solve as
# normal — we fall through to the existing fail/retry path, which on a
# fresh proxy often beats a second solve attempt on a flagged session.
TWOCAPTCHA_API_KEY = os.environ.get("TWOCAPTCHA_API_KEY", "").strip()
TWOCAPTCHA_IN_URL = "https://2captcha.com/in.php"
TWOCAPTCHA_RES_URL = "https://2captcha.com/res.php"
# 2Captcha typically returns reCAPTCHA in 15-45s, Turnstile in 5-20s.
# Poll every 5s, give up after 130s so a stuck solve doesn't hold the
# worker hostage — failing through to retry is cheaper than waiting.
TWOCAPTCHA_POLL_SECONDS = 5
TWOCAPTCHA_SOLVE_TIMEOUT_SECONDS = 130
# Seconds to let the page settle after injecting the token + submitting,
# before we re-probe whether the wall actually cleared.
TWOCAPTCHA_POST_INJECT_SETTLE_S = 6.0


# Hooks window.turnstile.render BEFORE Cloudflare's challenge script runs,
# so we can capture the params a Cloudflare *Challenge page* only exposes
# inside the render() call (sitekey, cData, chlPageData, action) — they are
# never in the static DOM, which is why DOM scraping found nothing. Params
# land in window.__cf_ts_params; the success callback in window.tsCallback.
# We STILL call the original render(), so this is inert/harmless when
# auto-solve is off — the manual noVNC widget renders exactly as before.
# Pattern per 2Captcha's Cloudflare-Turnstile docs (Challenge page case).
_TURNSTILE_INTERCEPTOR_JS = r"""
(function () {
  if (window.__cf_ts_hooked) return;
  window.__cf_ts_hooked = true;
  var iv = setInterval(function () {
    if (window.turnstile && typeof window.turnstile.render === 'function') {
      clearInterval(iv);
      var orig = window.turnstile.render.bind(window.turnstile);
      window.turnstile.render = function (a, b) {
        try {
          window.__cf_ts_params = {
            sitekey: b && b.sitekey,
            data: (b && b.cData) || null,
            pagedata: (b && b.chlPageData) || null,
            action: (b && b.action) || null,
            userAgent: navigator.userAgent,
            pageurl: window.location.href
          };
          if (b && typeof b.callback === 'function') window.tsCallback = b.callback;
        } catch (e) {}
        try { return orig(a, b); } catch (e) { return 'cf'; }
      };
    }
  }, 10);
})();
"""


def _install_turnstile_interceptor(driver) -> None:
    """Register the render-interceptor to run at document-start on every
    navigation (CDP Page.addScriptToEvaluateOnNewDocument). Best-effort —
    a failure just means Cloudflare Challenge pages won't auto-solve (they
    fall through to the existing path), so we log and continue."""
    try:
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": _TURNSTILE_INTERCEPTOR_JS},
        )
        print("[INFO] 2captcha: Turnstile render-interceptor installed")
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] 2captcha: could not install Turnstile interceptor: {exc}",
              file=sys.stderr)


def _extract_captcha_challenge(driver) -> dict | None:
    """Inspect the live DOM and classify the captcha + pull its sitekey.

    Returns {"kind": "recaptcha"|"turnstile"|"funcaptcha", "sitekey": str,
             "action": str|None, "cdata": str|None} or None when we can't
    identify a solvable challenge (caller skips 2Captcha and falls through).

    Most real walls (Bing's Cloudflare/Arkose interstitial, Google /sorry/)
    render the widget in a CROSS-ORIGIN iframe, so `data-sitekey` is never
    in the parent document — but the parent CAN read the iframe's `src`
    attribute, and the sitekey/public-key is encoded in that URL. We try
    data-sitekey first, then fall back to parsing iframe srcs. When both
    fail we log every iframe src so the next real challenge tells us the
    exact provider + URL shape instead of us guessing blind.
    """
    try:
        info = driver.execute_script("""
            function attr(sel, name) {
              var el = document.querySelector(sel);
              return el ? (el.getAttribute(name) || '') : '';
            }
            var iframes = [].slice.call(document.querySelectorAll('iframe'))
              .map(function (f) { return f.src || ''; })
              .filter(function (s) { return s; });

            // --- reCAPTCHA v2 (Google /sorry/) ---
            var reKey = attr('.g-recaptcha[data-sitekey]', 'data-sitekey')
                     || attr('[data-sitekey][class*="recaptcha"]', 'data-sitekey');
            if (!reKey) {
              for (var i = 0; i < iframes.length; i++) {
                var m = iframes[i].match(/recaptcha\\/(?:api2|enterprise)\\/anchor.*?[?&]k=([^&]+)/);
                if (m) { reKey = decodeURIComponent(m[1]); break; }
              }
            }
            if (reKey) return { kind: 'recaptcha', sitekey: reKey, iframes: iframes };

            // --- Cloudflare Turnstile via intercepted render() (Challenge page) ---
            // The interceptor captured the params Cloudflare only exposes
            // inside turnstile.render — this is the reliable path for Bing.
            if (window.__cf_ts_params && window.__cf_ts_params.sitekey) {
              var pp = window.__cf_ts_params;
              return { kind: 'turnstile', sitekey: pp.sitekey, action: pp.action || null,
                       cdata: pp.data || null, pagedata: pp.pagedata || null, iframes: iframes };
            }
            // --- Cloudflare Turnstile (standalone widget, sitekey in DOM) ---
            var tKey = attr('.cf-turnstile[data-sitekey]', 'data-sitekey')
                    || attr('[data-sitekey][id*="turnstile"]', 'data-sitekey');
            var tAction = attr('.cf-turnstile[data-sitekey]', 'data-action') || null;
            var tCdata = attr('.cf-turnstile[data-sitekey]', 'data-cdata') || null;
            if (!tKey) {
              for (var j = 0; j < iframes.length; j++) {
                if (iframes[j].indexOf('challenges.cloudflare.com') === -1) continue;
                // Turnstile sitekeys are 0x-prefixed; they appear as a path
                // segment in the challenge-platform iframe URL.
                var cm = iframes[j].match(/\\/(0x[0-9A-Za-z_-]{8,})\\b/);
                if (cm) { tKey = cm[1]; break; }
              }
            }
            if (tKey) return { kind: 'turnstile', sitekey: tKey, action: tAction, cdata: tCdata, iframes: iframes };

            // --- Arkose Labs FunCaptcha (Bing sometimes uses this) ---
            var aKey = '';
            for (var k = 0; k < iframes.length; k++) {
              if (iframes[k].indexOf('arkoselabs.com') === -1) continue;
              var am = iframes[k].match(/[?&](?:pk|pkey|public_key)=([^&]+)/);
              if (am) { aKey = decodeURIComponent(am[1]); break; }
            }
            if (aKey) return { kind: 'funcaptcha', sitekey: aKey, iframes: iframes };

            // Nothing solvable found — gather everything that could tell us
            // what this wall actually is (Cloudflare managed challenge stashes
            // cData / chlPageData / action in window._cf_chl_opt).
            var cfOpt = null;
            try { cfOpt = JSON.stringify(window._cf_chl_opt || null); } catch (e) { cfOpt = 'STRINGIFY_ERR'; }
            return {
              kind: null,
              iframes: iframes,
              cfChlOpt: cfOpt,
              title: document.title || '',
              url: location.href || '',
              htmlLen: (document.documentElement.outerHTML || '').length
            };
        """)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] 2captcha: sitekey extraction failed: {exc}", file=sys.stderr)
        return None

    if not info or not info.get("sitekey"):
        # Diagnostic: dump what iframes WERE present so we can learn the
        # real provider/URL shape from the next live challenge. This is the
        # single most useful signal when a wall isn't auto-solving.
        info = info or {}
        iframes = info.get("iframes") or []
        print("[WARN] 2captcha: no extractable sitekey on the wall — skipping auto-solve",
              file=sys.stderr)
        print(f"[DEBUG] 2captcha: wall title={info.get('title')!r} "
              f"url={(info.get('url') or '')[:120]!r} htmlLen={info.get('htmlLen')}",
              file=sys.stderr)
        if iframes:
            print(f"[DEBUG] 2captcha: {len(iframes)} iframe(s) on the wall:", file=sys.stderr)
            for src in iframes[:12]:
                print(f"[DEBUG] 2captcha:   iframe src = {src[:300]}", file=sys.stderr)
        else:
            print("[DEBUG] 2captcha: no iframes in the parent document "
                  "(challenge may be nested in a cross-origin frame we can't read)",
                  file=sys.stderr)
        # Cloudflare managed-challenge state — the params 2Captcha's
        # Cloudflare-Challenge method would need, if this is one.
        cf_opt = info.get("cfChlOpt")
        if cf_opt and cf_opt not in ("null", "STRINGIFY_ERR"):
            print(f"[DEBUG] 2captcha: window._cf_chl_opt = {cf_opt[:1200]}", file=sys.stderr)
        else:
            print(f"[DEBUG] 2captcha: window._cf_chl_opt = {cf_opt}", file=sys.stderr)
        # Dump the full wall HTML so we can inspect the exact challenge
        # structure offline and decide the right solve method.
        try:
            dump_path = f"/tmp/captcha_wall_{int(time.time() * 1000)}.html"
            with open(dump_path, "w", encoding="utf-8") as fh:
                fh.write(driver.page_source or "")
            print(f"[DEBUG] 2captcha: wall HTML dumped to {dump_path}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print(f"[DEBUG] 2captcha: wall HTML dump failed: {exc}", file=sys.stderr)
        return None
    return info


def _2captcha_submit(challenge: dict, page_url: str) -> str | None:
    """POST the challenge to 2Captcha's in.php. Returns the request id."""
    params = {"key": TWOCAPTCHA_API_KEY, "json": 1, "pageurl": page_url}
    if challenge["kind"] == "recaptcha":
        params["method"] = "userrecaptcha"
        params["googlekey"] = challenge["sitekey"]
    elif challenge["kind"] == "funcaptcha":
        params["method"] = "funcaptcha"
        params["publickey"] = challenge["sitekey"]
    else:  # turnstile
        params["method"] = "turnstile"
        params["sitekey"] = challenge["sitekey"]
        # action/data/pagedata are required for Cloudflare *Challenge pages*
        # (the Bing case); harmless/omitted for standalone Turnstile widgets.
        if challenge.get("action"):
            params["action"] = challenge["action"]
        if challenge.get("cdata"):
            params["data"] = challenge["cdata"]
        if challenge.get("pagedata"):
            params["pagedata"] = challenge["pagedata"]
    try:
        resp = requests.post(TWOCAPTCHA_IN_URL, data=params, timeout=30)
        body = resp.json()
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] 2captcha submit failed: {exc}", file=sys.stderr)
        return None
    if body.get("status") == 1:
        print(f"[INFO] 2captcha: submitted {challenge['kind']} (id={body['request']})")
        return str(body["request"])
    print(f"[ERROR] 2captcha submit rejected: {body.get('request')}", file=sys.stderr)
    return None


def _2captcha_poll(request_id: str) -> str | None:
    """Poll res.php until the token is ready, or timeout. Returns token."""
    deadline = time.time() + TWOCAPTCHA_SOLVE_TIMEOUT_SECONDS
    # 2Captcha asks callers to wait before the first poll; respect that.
    time.sleep(TWOCAPTCHA_POLL_SECONDS)
    while time.time() < deadline:
        try:
            resp = requests.get(
                TWOCAPTCHA_RES_URL,
                params={"key": TWOCAPTCHA_API_KEY, "action": "get",
                        "id": request_id, "json": 1},
                timeout=30,
            )
            body = resp.json()
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] 2captcha poll error: {exc}", file=sys.stderr)
            time.sleep(TWOCAPTCHA_POLL_SECONDS)
            continue
        if body.get("status") == 1:
            print("[INFO] 2captcha: token ready")
            return str(body["request"])
        reason = body.get("request", "")
        if reason != "CAPCHA_NOT_READY":  # 2Captcha's spelling, not ours
            # Hard error (ERROR_CAPTCHA_UNSOLVABLE, ERROR_ZERO_BALANCE, …)
            print(f"[ERROR] 2captcha solve failed: {reason}", file=sys.stderr)
            return None
        time.sleep(TWOCAPTCHA_POLL_SECONDS)
    print(f"[WARN] 2captcha: timed out after {TWOCAPTCHA_SOLVE_TIMEOUT_SECONDS}s",
          file=sys.stderr)
    return None


def _inject_token_and_submit(driver, kind: str, token: str) -> None:
    """Inject the solved token into the page and trigger continuation.

    reCAPTCHA: write the token into #g-recaptcha-response, invoke any
    registered grecaptcha callback, then submit the enclosing form.
    Turnstile: write into the cf-turnstile-response field(s) and submit.
    All best-effort — we re-probe the page state after, rather than
    trusting any single trigger to have worked.
    """
    try:
        if kind == "recaptcha":
            driver.execute_script("""
                var tok = arguments[0];
                var ta = document.getElementById('g-recaptcha-response');
                if (!ta) {
                  ta = document.createElement('textarea');
                  ta.id = 'g-recaptcha-response';
                  ta.name = 'g-recaptcha-response';
                  ta.style.display = 'block';
                  document.body.appendChild(ta);
                }
                ta.style.display = 'block';
                ta.value = tok;
                ta.innerHTML = tok;
                // Fire any grecaptcha callback registered in the config.
                try {
                  var cfg = window.___grecaptcha_cfg;
                  if (cfg && cfg.clients) {
                    Object.keys(cfg.clients).forEach(function (k) {
                      var c = cfg.clients[k];
                      JSON.stringify(c, function (key, val) {
                        if (val && typeof val.callback === 'function') {
                          try { val.callback(tok); } catch (e) {}
                        }
                        return val;
                      });
                    });
                  }
                } catch (e) {}
                var form = ta.closest('form') || document.querySelector('form');
                if (form) form.submit();
            """, token)
        else:  # turnstile
            driver.execute_script("""
                var tok = arguments[0];
                var fired = false;
                // Challenge-page path: feed the token to the callback we
                // captured from turnstile.render — Cloudflare then continues
                // (and reloads) on its own. This is the documented approach.
                if (typeof window.tsCallback === 'function') {
                  try { window.tsCallback(tok); fired = true; } catch (e) {}
                }
                // Standalone-widget path: write the token into the response
                // field(s) the form reads.
                ['cf-turnstile-response', 'g-recaptcha-response'].forEach(function (n) {
                  document.querySelectorAll('[name="' + n + '"]').forEach(function (el) {
                    el.value = tok;
                  });
                });
                // Only force a submit when we couldn't fire the captured
                // callback — submitting a Challenge page ourselves would
                // fight Cloudflare's own continuation.
                if (!fired) {
                  var form = document.querySelector('form');
                  if (form) form.submit();
                }
            """, token)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] 2captcha: token injection raised: {exc}", file=sys.stderr)


def attempt_auto_captcha_solve(driver) -> bool:
    """Try to clear the current captcha wall via 2Captcha.

    Returns True only when the wall is verifiably gone afterward. Returns
    False (cheaply) when auto-solve is disabled, the key is missing, the
    challenge isn't identifiable, the solve fails, or the wall is still
    up after injection — the caller then falls through to its existing
    manual-checkpoint / fail path.
    """
    if not TWOCAPTCHA_API_KEY:
        return False
    if not _fetch_captcha_auto_solve_enabled():
        return False

    challenge = _extract_captcha_challenge(driver)
    if not challenge:
        return False

    try:
        page_url = driver.current_url or ""
    except Exception:  # noqa: BLE001
        page_url = ""
    if not page_url:
        return False

    print(f"[INFO] 2captcha: attempting auto-solve ({challenge['kind']}, "
          f"sitekey={challenge['sitekey'][:12]}…)")
    request_id = _2captcha_submit(challenge, page_url)
    if not request_id:
        return False
    token = _2captcha_poll(request_id)
    if not token:
        return False

    _inject_token_and_submit(driver, challenge["kind"], token)
    time.sleep(TWOCAPTCHA_POST_INJECT_SETTLE_S)

    # Re-probe: did the wall actually clear? We reuse the silent checker
    # (no escalation) so a still-up challenge just reports False.
    still_blocked = _is_captcha_silent(driver)
    if still_blocked:
        print("[WARN] 2captcha: token injected but wall still up — "
              "falling through to existing path", file=sys.stderr)
        return False
    print("[INFO] 2captcha: wall cleared — resuming scrape")
    return True


def check_for_captcha(driver, *, job_id=None, worker_id=None, worker_port=None, interactive=None):
    """Detect if Google is showing a CAPTCHA or unusual traffic page.

    When interactive=True AND --job-id is set, instead of raising we
    park the job at an interactive checkpoint and wait for an admin
    to click through via noVNC. After resume, re-check; if still
    captcha'd, fall through to the legacy raise.

    Falls back to module-level _CAPTCHA_SOLVER_CTX (set by main()) when
    kwargs aren't passed, so existing call sites don't need to be
    re-threaded.
    """
    if job_id is None:
        job_id = _CAPTCHA_SOLVER_CTX.get("job_id")
    if worker_id is None:
        worker_id = _CAPTCHA_SOLVER_CTX.get("worker_id")
    if worker_port is None:
        worker_port = _CAPTCHA_SOLVER_CTX.get("worker_port", 9222)
    if interactive is None:
        interactive = _CAPTCHA_SOLVER_CTX.get("interactive", False)
    def _is_captcha() -> bool:
        try:
            cur = driver.current_url or ""
        except Exception:  # noqa: BLE001
            cur = ""
        if "/sorry/" in cur or "captcha" in cur.lower():
            return True
        try:
            page = (driver.page_source or "").lower()
        except Exception:  # noqa: BLE001
            page = ""
        if "unusual traffic" in page or "recaptcha" in page or "captcha" in page:
            return True
        return False

    if not _is_captcha():
        return

    # Google's /sorry/ page renders 'IP-Adresse: A ≠ B' (the U+2260 glyph)
    # when the IP that originated the search differs from the IP solving the
    # challenge — typically because the residential proxy rotated egress
    # mid-session. Google rejects any solution in that state, so parking at
    # a Captcha solver checkpoint just burns operator time. Skip straight to
    # the retry path so worker.py re-runs with a fresh GoLogin session.
    if _is_ip_mismatch_sorry_page(driver):
        print("[WARN] CAPTCHA detected with IP mismatch (proxy rotated mid-session) — "
              "unsolvable, skipping Captcha solver and failing fast for retry",
              file=sys.stderr)
        raise CaptchaDetectedException("CAPTCHA detected (IP mismatch)")

    # Automated 2Captcha first (when enabled + key present). A clean solve
    # resumes the scrape with zero operator involvement. Anything less —
    # disabled, unsolvable, timed out, or still blocked after injection —
    # returns False and we fall through to the manual / fail path below.
    if attempt_auto_captcha_solve(driver):
        return

    if interactive and job_id:
        try:
            cleared = _request_interactive_checkpoint_with_refresh(
                driver,
                job_id=job_id,
                worker_id=worker_id,
                worker_port=worker_port,
                reason="captcha",
                is_still_blocked=_is_captcha,
            )
        except InteractiveCancelException:
            # Operator clicked Cancel — bubble out as captcha so the
            # worker logs / classifies the failure consistently.
            raise CaptchaDetectedException("operator cancelled at captcha checkpoint")
        if cleared:
            return
        # All refresh attempts exhausted (helper already emitted
        # RESULT_MARKER_CAPTCHA_SOLVER_TIMEOUT). Fall through to fail.

    raise CaptchaDetectedException("CAPTCHA detected")

# ---------------------------
# Mobile-pass helpers
# ---------------------------
# A lot of casino-vertical PPC campaigns are configured "mobile only"
# in Google Ads — the ad creative never renders on a desktop SERP. To
# surface those, scrape_google_search runs a second pass after the
# desktop loop: switches the tab to iPhone UA + 375x812 via CDP,
# re-fetches page 0, and harvests any sponsored URLs that weren't in
# the desktop result set. Each result then carries seen_on so the team
# can filter for the mobile-only cohort.

# Recent iPhone Safari UA. Bump when newer iOS versions get UA-sniffed.
_MOBILE_IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.4 Mobile/15E148 Safari/604.1"
)


def _set_mobile_viewport(driver) -> bool:
    """Switch the running tab to iPhone UA + 375x812 viewport via CDP.
    Sticks for the rest of the driver session — fine here because each
    job runs in a freshly-started GoLogin profile that gets torn down
    after the scrape completes."""
    try:
        driver.execute_cdp_cmd("Network.setUserAgentOverride", {
            "userAgent": _MOBILE_IPHONE_UA,
            "platform": "iPhone",
            "userAgentMetadata": {
                "platform": "iOS",
                "platformVersion": "17.4",
                "architecture": "",
                "model": "iPhone",
                "mobile": True,
            },
        })
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": 375,
            "height": 812,
            "deviceScaleFactor": 3,
            "mobile": True,
        })
        driver.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {
            "enabled": True,
            "maxTouchPoints": 5,
        })
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] mobile viewport CDP override failed: {exc}", file=sys.stderr)
        return False


def _is_ip_mismatch_sorry_page(driver) -> bool:
    """Detect Google's unsolvable IP-mismatch captcha.

    Google's /sorry/ page includes a line like 'IP-Adresse: A ≠ B' (U+2260)
    when the egress IP at solve time differs from the IP that originated
    the search — i.e. the residential proxy rotated mid-session. Google
    refuses to accept any solution in that state, so the only sane response
    is to fail fast and let worker.py retry on a fresh GoLogin session.
    The '≠' glyph is Google-specific to this error and a reliable marker.
    """
    try:
        cur = driver.current_url or ""
    except Exception:  # noqa: BLE001
        cur = ""
    if "/sorry/" not in cur:
        return False
    try:
        page = driver.page_source or ""
    except Exception:  # noqa: BLE001
        page = ""
    return "≠" in page or "&#8800;" in page or "&#x2260;" in page


def _is_captcha_silent(driver) -> bool:
    """Cheap captcha check that does NOT escalate to the Captcha solver.
    Used by the mobile pass — if Google blocks the second request, we
    prefer to abort the mobile pass silently and preserve the
    already-saved desktop results, rather than freezing the whole scrape
    in a Captcha solver checkpoint over an enhancement pass."""
    try:
        cur = (driver.current_url or "").lower()
    except Exception:  # noqa: BLE001
        cur = ""
    if "/sorry/" in cur or "captcha" in cur:
        return True
    try:
        page = (driver.page_source or "").lower()
    except Exception:  # noqa: BLE001
        page = ""
    return "unusual traffic" in page or "recaptcha" in page or "captcha" in page


# ---------------------------
# Google scraping
# ---------------------------
def get_google_results_selenium(driver, keyword, country, page=0, language="en", wait_for_sponsored=True, silent_captcha=False):
    """Fetch + parse one Google SERP page.

    silent_captcha=False (default): on captcha, escalates via check_for_captcha
      which honours the Captcha solver when enabled. Raises CaptchaDetectedException otherwise.
    silent_captcha=True: on captcha, returns None (the caller should treat
      this as 'abort this pass, preserve other results'). Used by the mobile
      pass in view_mode='both' so a mobile-only captcha can't wipe the
      desktop results that already landed.
    """
    start = page * 10
    encoded_keyword = quote_plus(keyword)
    url = f"https://www.google.com/search?q={encoded_keyword}&hl={language}&start={start}"

    print(f"[INFO] Navigating to: {url}")
    driver.get(url)

    if silent_captcha:
        if _is_captcha_silent(driver):
            print(f"[WARN] silent captcha detected on page {page + 1} — aborting silently")
            return None
    else:
        check_for_captcha(driver)

    accept_google_consent(driver)

    # Wait for the results container. `#rso` is the inner results-only
    # div that Google renders on BOTH desktop and mobile SERPs (same ID,
    # same purpose). The old `#search` wait targeted the outer wrapper
    # that mobile layouts don't render — so the wait timed out on every
    # mobile-pass scrape and returned [] silently.
    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.ID, "rso"))
        )
    except:
        # Dump the unparsed page_source to /tmp so we can inspect the
        # DOM shape Google is actually serving. Without this, a parser
        # failure is invisible — the function returns [] and the only
        # signal is a single WARN line in the worker log. With it, the
        # next failed mobile pass leaves a copy of the HTML we can
        # scp back to a workstation and grep for the real container ID.
        try:
            dump_path = f"/tmp/scrape_rso_miss_{int(time.time() * 1000)}_p{page}.html"
            with open(dump_path, "w", encoding="utf-8") as f:
                f.write(driver.page_source or "")
            print(f"[WARN] Results container (#rso) not found — dumped page_source to {dump_path}")
        except Exception as dump_exc:  # noqa: BLE001
            print(f"[WARN] Results container (#rso) not found (dump failed: {dump_exc})")
        return []

    if wait_for_sponsored:
        wait_for_sponsored_results(driver, timeout=7)

    sponsored_map = extract_sponsored_urls_selenium(driver)
    sponsored_urls = set(sponsored_map.keys())

    # Per-PPC-ad: snap the ad card on the SERP first (always-on, ~100%
    # reliable — what the searcher actually saw), then best-effort
    # click-through to resolve the full URL with gclid + gad_*.
    # Two screenshots per PPC ad:
    #   serp_screenshots[ppc_url]    — the ad card on Google's SERP (100% reliable)
    #   landing_screenshots[ppc_url] — the post-click landing page (cloakers may
    #                                  win, but the real-user Ctrl+Click gesture
    #                                  beats them more often than not). When this
    #                                  fails the lead falls back to the enrichment
    #                                  pass for the landing-page screenshot.
    serp_screenshots: dict = {}
    landing_screenshots: dict = {}
    resolved_ppc_urls: dict = {}
    for idx, (ppc_url, anchor) in enumerate(sponsored_map.items()):
        out_path = f"/tmp/serp_ad_{int(time.time() * 1000)}_{page}_{idx}.png"
        if capture_serp_card_screenshot(driver, anchor, out_path):
            serp_screenshots[ppc_url] = out_path

        landing_path = f"/tmp/ppc_landing_{int(time.time() * 1000)}_{page}_{idx}.png"
        full, landing_taken = click_through_ppc(driver, anchor, landing_path)
        if landing_taken:
            landing_screenshots[ppc_url] = landing_path
        if full:
            resolved_ppc_urls[ppc_url] = full
            print(f"[DEBUG] Resolved PPC URL: {ppc_url} → {full}")

    soup = BeautifulSoup(driver.page_source, "html.parser")
    results = []
    position = 1
    overall_position = 1

    # --- Organic results ---
    # Desktop SERPs wrap each result title in <h3>; mobile SERPs wrap it
    # in <div role="heading"> instead. Both live under #rso and both are
    # nested inside the result anchor. Iterate the union so the parser
    # works regardless of which layout Google serves the session.
    for h3 in soup.select("#rso a h3") + soup.select("#rso a div[role='heading']"):
        a = h3.find_parent("a")
        if not a:
            continue

        link = a.get("href")
        if not link or not link.startswith("http"):
            continue

        result_type = "PPC" if link in sponsored_urls else "Organic"

        # Extract base URL (scheme + netloc) — derived from the bare
        # data-pcu link so the `domain` column is clean even when the
        # resolved PPC URL is full-of-tracking-params.
        parsed = urlparse(link)
        full_url = f"{parsed.scheme}://{parsed.netloc}"

        # PPC ONLY: swap `url` with the resolved full destination
        # (gclid + gad_* + everything Google appended). Organic rows
        # keep their bare URL untouched.
        url_value = link
        if result_type == "PPC" and link in resolved_ppc_urls:
            url_value = resolved_ppc_urls[link]

        result_row = {
            "url": url_value,
            "full_url": full_url,
            "title": h3.get_text(strip=True),
            "resultType": result_type,
            "page": page + 1,
            "position": position if result_type == "Organic" else None,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country,
        }
        if result_type == "PPC" and link in serp_screenshots:
            # local_serp_screenshot is the on-disk path; the worker
            # rewrites it to a Storage bucket path before it ever
            # reaches the DB.
            result_row["local_serp_screenshot"] = serp_screenshots[link]
        if result_type == "PPC" and link in landing_screenshots:
            result_row["local_landing_screenshot"] = landing_screenshots[link]
        results.append(result_row)

        overall_position += 1
        if result_type == "Organic":
            position += 1

    # --- PPC results not included in organic ---
    for ppc_url in sponsored_urls:
        # Skip if we already emitted a row for this ad (matched by the
        # full resolved URL OR the bare data-pcu — either way it's the
        # same ad and we avoid duplicating it).
        resolved = resolved_ppc_urls.get(ppc_url, ppc_url)
        if any(r["url"] == ppc_url or r["url"] == resolved for r in results):
            continue
        a_tag = soup.find("a", href=ppc_url) or soup.find("a", {"data-pcu": ppc_url})
        title = a_tag.get_text(strip=True) if a_tag else ""

        # Extract base URL for the `domain` column from the bare
        # data-pcu link, even when storing the full resolved URL.
        parsed = urlparse(ppc_url)
        full_url = f"{parsed.scheme}://{parsed.netloc}"

        result_row = {
            "url": resolved,
            "full_url": full_url,
            "title": title,
            "resultType": "PPC",
            "page": page + 1,
            "position": None,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country,
        }
        if ppc_url in serp_screenshots:
            result_row["local_serp_screenshot"] = serp_screenshots[ppc_url]
        if ppc_url in landing_screenshots:
            result_row["local_landing_screenshot"] = landing_screenshots[ppc_url]
        results.append(result_row)
        overall_position += 1

    print(
        f"[INFO] Page {page + 1}: "
        f"{sum(r['resultType']=='PPC' for r in results)} PPC | "
        f"{sum(r['resultType']=='Organic' for r in results)} Organic"
    )

    return results

# ---------------------------
# Scrape multiple pages
# ---------------------------
def scrape_google_search(
    driver, keyword, country,
    max_pages=5, delay_min=2, delay_max=5,
    language="en",
    view_mode="both",
):
    """
    Per-job view_mode: 'desktop' (legacy), 'mobile' (iPhone-only), or 'both'.

    In 'both' mode the desktop pass runs first with normal
    Captcha-solver-aware captcha handling. Then the mobile pass switches
    the tab to iPhone UA + 375x812 viewport via CDP and re-fetches every
    page with silent-captcha behaviour — a mobile-side captcha never
    wipes the desktop results we already have. URLs seen in both passes
    get seen_on='both'; URLs only on mobile get seen_on='mobile'.

    In 'mobile' mode there's only one pass (mobile) and the captcha
    handler is the regular Captcha-solver-aware one — operator must
    resolve to continue. All results land seen_on='mobile'.

    In 'desktop' mode only the legacy desktop pass runs; everything is
    seen_on='desktop'. (We honour MOBILE_PASS_ENABLED=off at the worker
    layer by forcing this mode regardless of the per-job choice.)
    """
    all_results: list[dict] = []
    login_state = None

    run_desktop = view_mode in ("desktop", "both")
    run_mobile = view_mode in ("mobile", "both")
    mobile_is_primary = (view_mode == "mobile")

    # ---- Desktop pass ----
    if run_desktop:
        for page in range(max_pages):
            page_results = get_google_results_selenium(
                driver, keyword, country, page, language=language,
            )
            # Stamp every desktop-pass row up front. The mobile pass below
            # flips overlapping rows to 'both' and tags new ones as 'mobile'.
            for r in page_results:
                r["seen_on"] = "desktop"
            all_results.extend(page_results)

            # Capture login state from page 1 (later pages may have
            # different layouts where the avatar isn't rendered).
            if page == 0:
                login_state = detect_login_state(driver)
                print(f"[INFO] Login-state detected: {login_state}")

            if page < max_pages - 1:
                time.sleep(random.uniform(delay_min, delay_max))

    # ---- Mobile pass ----
    mobile_summary = {"new": 0, "both": 0, "skipped_reason": None}
    if run_mobile:
        if not _set_mobile_viewport(driver):
            mobile_summary["skipped_reason"] = "viewport_setup_failed"
        else:
            # Brief gap after viewport switch so Google doesn't see two
            # consecutive SERP loads <1s apart from the same session.
            time.sleep(random.uniform(2.5, 4.5))

            mobile_results: list[dict] | None = []
            for page in range(max_pages):
                if page > 0:
                    time.sleep(random.uniform(delay_min, delay_max))

                # Captcha behaviour:
                #  - mobile primary → Captcha solver flow (same as desktop). Operator
                #    must resolve; otherwise raises CaptchaDetectedException.
                #  - mobile in 'both' mode → silent abort. Returns None;
                #    desktop results already in all_results are preserved.
                try:
                    page_results = get_google_results_selenium(
                        driver, keyword, country, page, language=language,
                        silent_captcha=not mobile_is_primary,
                    )
                except CaptchaDetectedException:
                    # Only raised in primary-mobile mode (Captcha solver path) — let
                    # the worker classify it as CAPTCHA / CAPTCHA_SOLVER_TIMEOUT
                    # at exit.
                    raise

                if page_results is None:
                    print(f"[WARN] Mobile pass: silent captcha on page {page + 1} — aborting (other results preserved)")
                    mobile_summary["skipped_reason"] = "captcha"
                    mobile_results = None
                    break

                mobile_results.extend(page_results)

                # Capture login state from mobile pass when running mobile-
                # only (no desktop pass set it).
                if page == 0 and login_state is None:
                    login_state = detect_login_state(driver)
                    print(f"[INFO] Login-state detected (mobile): {login_state}")

            # ---- Merge mobile results ----
            if mobile_results is None:
                pass  # captcha aborted; skipped_reason already set
            elif len(mobile_results) == 0:
                # Pass ran cleanly but returned zero rows on every page.
                # Either the SERP DOM didn't match our selectors (most
                # likely — desktop and mobile Google ship different result
                # containers) or the query genuinely had no mobile hits.
                # Flag it so /scrape can surface a "mobile pass parsed 0
                # results" banner instead of silently leaving every row
                # tagged seen_on='desktop' with no explanation.
                mobile_summary["skipped_reason"] = "parse_failed"
            elif mobile_is_primary:
                for r in mobile_results:
                    r["seen_on"] = "mobile"
                all_results.extend(mobile_results)
                mobile_summary["new"] = len(mobile_results)
            else:
                # 'both' mode dedupe vs the desktop pass already in all_results.
                for mr in mobile_results:
                    overlap = next(
                        (r for r in all_results
                         if r["url"] == mr["url"]
                         or (r.get("full_url") and r["full_url"] == mr.get("full_url"))),
                        None,
                    )
                    if overlap is not None:
                        overlap["seen_on"] = "both"
                        mobile_summary["both"] += 1
                    else:
                        mr["seen_on"] = "mobile"
                        all_results.append(mr)
                        mobile_summary["new"] += 1
                print(
                    f"[INFO] Mobile pass merged: {mobile_summary['new']} new "
                    f"mobile-only, {mobile_summary['both']} cross-device "
                    f"(also seen on desktop)"
                )

    # Deduplicate by domain before returning.
    all_results = deduplicate_results(all_results)

    return {
        "params": {
            "keyword": keyword,
            "country": country,
            "view_mode": view_mode,
        },
        "total_results": len(all_results),
        "organic_results": sum(r["resultType"] == "Organic" for r in all_results),
        "ppc_results": sum(r["resultType"] == "PPC" for r in all_results),
        # Per-view counts so /scrape can render a breakdown badge.
        "mobile_only_results": mobile_summary["new"] if not mobile_is_primary else 0,
        "cross_device_results": mobile_summary["both"],
        "mobile_pass_skipped": mobile_summary["skipped_reason"],
        "pages_scraped": max_pages,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": login_state,
        "results": all_results,
    }


# NOTE: the previous scrape_google_mobile_ppc function (mobile PPC sweep
# of page 0 only) has been removed. Its job is now handled by
# scrape_google_search's unified view_mode='both' / 'mobile' loop, which
# re-uses get_google_results_selenium under a mobile-emulated viewport
# and parses BOTH organic + PPC across all pages.

# ---------------------------
# Bing scraping
# ---------------------------
# Country display-name → ISO-2 code, used to set Bing's `cc=` query
# parameter so the SERP returns the country-specific results. Keep this
# in sync with the gologin_profiles seed in Supabase.
BING_COUNTRY_TO_CC = {
    "Australia": "AU", "Austria": "AT", "Bahrain": "BH",
    "Canada": "CA", "Denmark": "DK", "Germany": "DE",
    "Italy": "IT", "Kuwait": "KW", "New Zealand": "NZ",
    "Norway": "NO", "Oman": "OM", "Qatar": "QA",
    "Saudi Arabia": "SA", "UAE": "AE", "UK": "GB",
}


def _bing_first_http_anchor(block):
    """Return the first <a href="http..."> anywhere inside a Bing
    result block, preferring h2-nested anchors when available. Falls
    back to any descendant anchor — handles algo / algoSlug / topTitle
    / answer-card layouts in one place."""
    candidates = (
        block.select("h2 a")
        + block.select(".b_topTitle a")
        + block.select(".b_title a")
        + block.select("a")
    )
    for a in candidates:
        href = a.get("href")
        if href and href.startswith("http"):
            return a
    return None


# Bing wraps every result href in https://www.bing.com/ck/a?…&u=<encoded>
# (a click-tracker). The u-parameter is a 2-char type prefix (e.g. "a1")
# followed by URL-safe base64 of the real target URL — either a relative
# path like "/images/search?…" or an absolute "https://…".
_BING_CK_U_RE = re.compile(r'[?&]u=([^&]+)')


def _decode_bing_ck_url(href):
    """Decode a bing.com/ck/a click-tracker into its real target URL.

    Returns the input unchanged when href isn't a recognizable ck/a
    redirect or the base64 payload can't be decoded.
    """
    if not href or "/ck/a" not in href:
        return href
    m = _BING_CK_U_RE.search(href)
    if not m:
        return href
    payload = m.group(1)
    if len(payload) < 3:
        return href
    body = payload[2:].replace('-', '+').replace('_', '/')
    body += '=' * (-len(body) % 4)
    try:
        decoded = base64.b64decode(body).decode('utf-8')
    except Exception:
        return href
    if decoded.startswith('//'):
        return 'https:' + decoded
    if decoded.startswith('/'):
        return 'https://www.bing.com' + decoded
    if not decoded.startswith('http'):
        return href
    return decoded


def _bing_serp_state(driver):
    """Classify the current Bing page as 'captcha', 'results', or ''.

    - 'captcha': Cloudflare Turnstile challenge is up. No amount of
      waiting will produce results on the current proxy/fingerprint.
    - 'results': result containers (b_algo / data-bm) have hydrated.
    - '': neither yet — keep waiting.
    """
    try:
        return driver.execute_script("""
            var src = document.documentElement.outerHTML;
            if (src.indexOf('CloudflareHandleCaptcha') !== -1
                || src.indexOf('challenge/verify') !== -1
                || src.indexOf('captcha_text') !== -1) {
              return 'captcha';
            }
            if (document.querySelector('li.b_algo, li[data-bm], div[data-bm]') !== null) {
              return 'results';
            }
            return '';
        """) or ''
    except Exception:
        return ''


def get_bing_results(driver, keyword, country, page=0, language="en"):
    """
    Single-page Bing SERP fetch + parse. Returns the same per-result
    shape as get_google_results_selenium so downstream code is engine-
    agnostic.

    Flow on page 0: visit bing.com, dismiss the consent banner, type
    the keyword in the search box, submit. This is more "human-like"
    than navigating directly to /search?q=… and seems to dodge the
    degraded-SERP that Bing serves to first-time direct-URL hits.

    Pages 1+ navigate by URL (?first=<offset>) — cookies + consent
    are established by the page-0 search so direct nav works fine.
    """
    cc = BING_COUNTRY_TO_CC.get(country, "US")

    if page == 0:
        homepage = f"https://www.bing.com/?cc={cc}&setlang={language}"
        print(f"[INFO] Bing homepage: {homepage}")
        driver.get(homepage)
        check_for_captcha(driver)
        accept_bing_consent(driver)

        # Find the search box (id has been stable as sb_form_q for
        # years) and type the keyword with small per-char delays so
        # the keystroke pattern looks human.
        try:
            search_input = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.ID, "sb_form_q"))
            )
            search_input.clear()
            for ch in keyword:
                search_input.send_keys(ch)
                time.sleep(random.uniform(0.03, 0.12))
            time.sleep(random.uniform(0.4, 0.9))
            search_input.send_keys(Keys.RETURN)
            # Wait until the URL contains /search? — confirms the form
            # actually submitted and we're on a SERP, not still on the
            # homepage. Bing's submit can be slow when the proxy is
            # cold; wait up to 15s.
            try:
                WebDriverWait(driver, 15).until(
                    lambda d: "/search" in d.current_url
                )
                print(f"[INFO] Bing post-submit URL: {driver.current_url}")
            except Exception:
                print("[WARN] Bing did not navigate to /search after submit; URL still " + driver.current_url)
        except Exception as exc:
            # Fallback: if the search box vanished or moved, fall
            # back to direct URL nav so we still get something.
            print(f"[WARN] Bing search-box interaction failed ({exc}), falling back to URL nav")
            encoded_keyword = quote_plus(keyword)
            fallback_url = (
                f"https://www.bing.com/search?q={encoded_keyword}"
                f"&cc={cc}&setlang={language}&first=1"
            )
            driver.get(fallback_url)
            check_for_captcha(driver)
    else:
        first = page * 10 + 1
        encoded_keyword = quote_plus(keyword)
        url = (
            f"https://www.bing.com/search?q={encoded_keyword}"
            f"&cc={cc}&setlang={language}&first={first}"
        )
        print(f"[INFO] Bing page {page + 1} via URL: {url}")
        driver.get(url)
        check_for_captcha(driver)
        accept_bing_consent(driver)

    # Bing's result blocks (b_algo / data-bm) hydrate from JS several
    # seconds after navigation lands, so page_source captured immediately
    # would be empty. Wait until either:
    #   - Result containers actually appear in the DOM → parse them
    #   - Cloudflare's Turnstile challenge fires ("One last step…")
    #     → bail loudly; gambling-class queries on flagged proxies hit
    #       this and won't settle no matter how long we wait
    # Up to 35s total. A scroll halfway through nudges lazy hydration.
    # Wait-loop budget is refreshed after a successful Captcha solver
    # resume so the post-challenge SERP has a full 35s to hydrate
    # (operator just spent 1–5 min on the challenge — don't immediately
    # time out on them).
    deadline = time.time() + 35
    scrolled = False
    captcha_detected = False
    captcha_solver_attempted = False
    while time.time() < deadline:
        state = _bing_serp_state(driver)
        if state == 'captcha':
            # Route through check_for_captcha so the Captcha solver fires
            # the same way it does on the Google path: if interactive mode
            # + job_id are set, park at an interactive_checkpoint and wait
            # for an admin to clear Turnstile via noVNC. Otherwise raises
            # CaptchaDetectedException, which main() turns into
            # [RESULT] CAPTCHA → worker auto-retry. Only attempt once
            # per page so a stuck challenge doesn't loop forever.
            if not captcha_solver_attempted:
                captcha_solver_attempted = True
                check_for_captcha(driver)
                # Operator resumed (or the Captcha solver was off and check_for_captcha
                # would have raised). Reset the wait budget and re-poll
                # — the post-challenge SERP needs time to hydrate.
                deadline = time.time() + 35
                scrolled = False
                time.sleep(1)
                continue
            captcha_detected = True
            break
        if state == 'results':
            break
        if not scrolled and time.time() > deadline - 20:
            try:
                driver.execute_script(
                    "window.scrollTo(0, document.body.scrollHeight / 2);"
                )
                scrolled = True
                print("[DEBUG] Bing scrolled to force lazy rendering")
            except Exception as exc:
                print(f"[WARN] scroll failed: {exc}")
        time.sleep(1)

    # Final settle — even once blocks are present, give lazy chunks
    # a moment to finish painting.
    time.sleep(2)

    page_source = driver.page_source
    landed_url = driver.current_url
    print(f"[INFO] Bing landed URL: {landed_url}")
    _maybe_save_bing_debug(page_source, landed_url)

    # Captcha gate. Two ways we get here with captcha still up:
    #   1. captcha_detected=True from the wait loop — the Captcha solver
    #      already fired once and still didn't clear. Don't loop it a
    #      second time; just return [] and let the worker decide
    #      (auto-retry with a fresh proxy/fingerprint usually beats
    #      another human attempt on the same flagged session).
    #   2. State only flipped to captcha during the 2s post-loop settle
    #      → we never went through the in-loop Captcha solver branch.
    #      Give it one Captcha solver attempt via check_for_captcha. If
    #      the Captcha solver is off this also raises
    #      CaptchaDetectedException → main() emits [RESULT] CAPTCHA →
    #      worker auto-retries.
    if captcha_detected:
        print(
            "[WARN] Bing Turnstile still up after Captcha solver attempt — "
            "bailing this page."
        )
        return []
    if _bing_serp_state(driver) == 'captcha':
        print(
            "[WARN] Bing returned a Cloudflare Turnstile challenge "
            "(server-side bot detection). This proxy/fingerprint is "
            "currently flagged for this query class."
        )
        check_for_captcha(driver)
        if _bing_serp_state(driver) == 'captcha':
            return []
        # Operator solved it during the late check — re-grab the source
        # so the parser below sees the post-challenge SERP, not the
        # challenge HTML we captured at line 1670.
        page_source = driver.page_source
        landed_url = driver.current_url
        print(f"[INFO] Bing post-Captcha-solver landed URL: {landed_url}")

    # SERP ad-card screenshots — Selenium pass first because element
    # screenshots need WebElement references (BeautifulSoup tags can't
    # be screenshotted). Map decoded-href → on-disk PNG; the BeautifulSoup
    # builder below attaches the path to each PPC result row via the
    # same local_serp_screenshot field the Google path uses, so the
    # worker's existing upload helper handles both engines uniformly.
    bing_serp_screenshots: dict = {}
    try:
        ad_containers = driver.find_elements(
            By.CSS_SELECTOR,
            'li.b_ad, li.b_adTop, li.b_adBottom, li.b_adLastChild',
        )
        for idx, container in enumerate(ad_containers):
            decoded = None
            try:
                anchors = container.find_elements(By.CSS_SELECTOR, 'a[href^="http"]')
                for a in anchors:
                    raw = a.get_attribute('href')
                    if not raw:
                        continue
                    candidate = _decode_bing_ck_url(raw)
                    if candidate and candidate.startswith('http') and (
                        'bing.com/' not in candidate or '/search?' not in candidate
                    ):
                        decoded = candidate
                        break
            except Exception:  # noqa: BLE001
                continue
            if not decoded or decoded in bing_serp_screenshots:
                continue
            out_path = f"/tmp/serp_ad_{int(time.time() * 1000)}_{page}_{idx}.png"
            # capture_serp_card_screenshot walks up for Google-specific
            # ancestors and falls back to the element it was handed when
            # none match — so passing the Bing ad container directly
            # screenshots the whole card, which is exactly what we want.
            if capture_serp_card_screenshot(driver, container, out_path):
                bing_serp_screenshots[decoded] = out_path
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] Bing SERP ad-card capture pass failed: {exc}", file=sys.stderr)

    soup = BeautifulSoup(page_source, "html.parser")
    # Crude size sanity check — if the page is suspiciously small, we
    # probably hit a consent banner / interstitial / redirect rather
    # than a real SERP.
    if len(page_source) < 5000:
        print(f"[WARN] Bing page_source is only {len(page_source)} bytes — likely an interstitial")
    results = []
    position = 1
    overall_position = 1
    seen_hrefs = set()

    # ----- Sponsored / ads -----
    ad_blocks = soup.select("li.b_ad, li.b_adTop, li.b_adBottom, li.b_adLastChild, .b_adProvider")
    print(f"[DEBUG] Bing ad blocks found: {len(ad_blocks)}")
    for ad_block in ad_blocks:
        a = _bing_first_http_anchor(ad_block)
        if not a:
            continue
        href = _decode_bing_ck_url(a.get("href"))
        if not href or href in seen_hrefs:
            continue
        if "bing.com/" in href and "/search?" in href:
            continue
        title = a.get_text(strip=True)
        if not title:
            continue
        seen_hrefs.add(href)
        parsed = urlparse(href)
        full_url = f"{parsed.scheme}://{parsed.netloc}"
        result_row = {
            "url": href,
            "full_url": full_url,
            "title": title,
            "resultType": "PPC",
            "page": page + 1,
            "position": None,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country,
        }
        if href in bing_serp_screenshots:
            result_row["local_serp_screenshot"] = bing_serp_screenshots[href]
        results.append(result_row)
        overall_position += 1

    # ----- Organic -----
    # Bing uses a few wrappers depending on the result kind. b_algo is
    # the standard, b_algo_group is a grouped result, b_algoSlug shows
    # up for some answer-style results, and the newest layouts wrap
    # results in [data-bm] block markers without a b_algo class at all.
    # Iterate over all of them and rely on _bing_first_http_anchor +
    # seen_hrefs to dedupe.
    organic_blocks = soup.select(
        "li.b_algo, li.b_algo_group, li.b_algoSlug, "
        "ol#b_results > li.b_ans, "
        "li[data-bm], div[data-bm]"
    )
    print(f"[DEBUG] Bing organic-like blocks found: {len(organic_blocks)}")
    for algo in organic_blocks:
        # Skip blocks already classified as ads above.
        cls = " ".join(algo.get("class") or [])
        if "b_ad" in cls:
            continue
        a = _bing_first_http_anchor(algo)
        if not a:
            continue
        href = _decode_bing_ck_url(a.get("href"))
        if not href or href in seen_hrefs:
            continue
        # Bing internal links (e.g. /search redirects, image carousels)
        # aren't real organic results — drop them. After ck/a decoding
        # these surface as https://www.bing.com/images/search?... etc.
        if "bing.com/" in href and "/search?" in href:
            continue
        seen_hrefs.add(href)
        title = a.get_text(strip=True)
        parsed = urlparse(href)
        full_url = f"{parsed.scheme}://{parsed.netloc}"
        results.append({
            "url": href,
            "full_url": full_url,
            "title": title,
            "resultType": "Organic",
            "page": page + 1,
            "position": position,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country,
        })
        position += 1
        overall_position += 1

    # Final fallback: if for whatever reason the structured selectors
    # missed everything, sweep #b_results for any http link anchored on
    # an h2/title-like ancestor. Catches truly unusual layouts but keeps
    # the dedupe via seen_hrefs.
    if len(results) < 3:
        for h2 in soup.select("#b_results h2"):
            a = h2.find("a", href=True)
            if not a:
                continue
            href = _decode_bing_ck_url(a.get("href"))
            if not href or not href.startswith("http") or href in seen_hrefs:
                continue
            if "bing.com/" in href and "/search?" in href:
                continue
            seen_hrefs.add(href)
            parsed = urlparse(href)
            full_url = f"{parsed.scheme}://{parsed.netloc}"
            results.append({
                "url": href,
                "full_url": full_url,
                "title": a.get_text(strip=True),
                "resultType": "Organic",
                "page": page + 1,
                "position": position,
                "overall_position": overall_position,
                "keyword": keyword,
                "country": country,
            })
            position += 1
            overall_position += 1

    print(
        f"[INFO] Bing page {page + 1}: "
        f"{sum(r['resultType']=='PPC' for r in results)} PPC | "
        f"{sum(r['resultType']=='Organic' for r in results)} Organic"
    )
    return results


def scrape_bing_search(driver, keyword, country, max_pages=5,
                       delay_min=2, delay_max=5, language="en"):
    """
    Multi-page Bing scraper. Returns the same dict shape as
    scrape_google_search so the worker doesn't need to know which
    engine produced the results.
    """
    all_results = []

    for page in range(max_pages):
        page_results = get_bing_results(driver, keyword, country, page, language=language)
        all_results.extend(page_results)
        if page < max_pages - 1:
            time.sleep(random.uniform(delay_min, delay_max))

    all_results = deduplicate_results(all_results)

    return {
        "params": {"keyword": keyword, "country": country},
        "total_results": len(all_results),
        "organic_results": sum(r["resultType"] == "Organic" for r in all_results),
        "ppc_results": sum(r["resultType"] == "PPC" for r in all_results),
        "pages_scraped": max_pages,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        # Bing doesn't have a meaningful "logged in to a Microsoft account"
        # signal we care about for our pipeline, so we don't try to
        # auto-bump the gologin_profiles flag from a Bing scrape.
        "is_logged_in": None,
        "results": all_results,
    }

# ---------------------------
# Webhook sender
# ---------------------------
def send_to_webhook(data, webhook_url):
    try:
        requests.post(
            webhook_url,
            json=data,
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        print("[INFO] Webhook sent")
    except Exception as e:
        print(f"[WARN] Webhook failed: {e}", file=sys.stderr)

# ---------------------------
# Save to JSON
# ---------------------------
def save_to_file(data, filename="/tmp/google_results.json"):
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

# ---------------------------
# Browser connectivity check
# ---------------------------
def check_browser_connectivity(driver):
    """Verify the browser and proxy are reachable before scraping"""
    try:
        driver.get("https://www.google.com/?hl=en")
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        return True
    except Exception as e:
        print(f"[WARN] Connectivity check failed: {e}")
        return False

# ---------------------------
# Main
# ---------------------------
MAX_RETRIES = 3

# Backoff (seconds) for transient GoLogin profile-download failures
# (BadZipFile = GoLogin API returned JSON/HTML error instead of a zip).
# Index by attempt number, capped at length.
BADZIP_BACKOFF_SECONDS = [30, 60, 120]


def clear_gologin_tmp(profile_id: str) -> None:
    """Remove the /tmp/gologin_<profile_id> dir if it exists.

    Called between BadZipFile retries — GoLogin's library will leave a
    partially-extracted profile behind on failed downloads, and re-using
    it on the next attempt keeps the zip-extract path failing.
    """
    tmp_path = os.path.join("/tmp", f"gologin_{profile_id}")
    try:
        if os.path.isdir(tmp_path):
            shutil.rmtree(tmp_path, ignore_errors=True)
            print(f"[INFO] Cleared stale GoLogin cache at {tmp_path}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] Could not clear {tmp_path}: {exc}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Start GoLogin profile and scrape Google or Bing search results"
    )

    parser.add_argument("profile_id", help="GoLogin profile ID")
    parser.add_argument("-k", "--keyword", required=True, help="Search keyword")
    parser.add_argument("-c", "--country", required=True, help="Country display name (e.g. 'Germany')")
    parser.add_argument("--country-code", default=None, help="2-letter ISO country code (e.g. 'DE'). Used to look up Google login credentials.")
    parser.add_argument("--requires-google-login", action="store_true", help="Treat this country as requires_google_login=true. When set, a logged-out profile escalates to the Captcha solver if no creds are configured.")
    parser.add_argument("--pages", type=int, default=10, help="Number of pages to scrape")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (must be unique per concurrent worker)")
    parser.add_argument("--output", default="/tmp/google_results.json", help="Path to write the results JSON")
    parser.add_argument("--webhook", default=None, help="Optional webhook URL to POST results to (not used by the Supabase worker)")
    parser.add_argument("--language", default="en", help="Search language code (en, ar, de, …)")
    parser.add_argument("--engine", default="google", choices=["google", "bing"], help="Which search engine to scrape")
    parser.add_argument(
        "--view-mode",
        choices=["desktop", "mobile", "both"],
        default="both",
        help=(
            "Per-job SERP view selection. 'desktop' (legacy) runs only the "
            "desktop pass; 'mobile' runs only the iPhone UA + 375x812 viewport "
            "pass; 'both' (default) runs both and merges results, marking "
            "each lead's seen_on column with desktop / mobile / both."
        ),
    )
    parser.add_argument("--job-id", default=None, help="scrape_queue.id (UUID). Required for human-in-the-loop checkpoints.")
    parser.add_argument("--worker-id", default=None, help="Worker identifier (e.g. vm1-9222). Logged on interactive checkpoints.")
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="When set, the scraper checkpoints on captcha/age-gate/cookie walls "
             "and polls scrape_queue for the operator to resume via the dashboard "
             "noVNC stream. When unset, walls fail the job immediately (legacy behaviour).",
    )

    args = parser.parse_args()

    # Stash the human-in-the-loop context where check_for_captcha and
    # ensure_google_login_if_required can find it without us threading
    # kwargs through every scrape helper.
    _CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    _CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    _CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    _CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)
    _CAPTCHA_SOLVER_CTX["country_code"] = (args.country_code or "").strip().upper() or None
    _CAPTCHA_SOLVER_CTX["requires_google_login"] = bool(args.requires_google_login)
    if args.interactive and not args.job_id:
        print("[WARN] --interactive set without --job-id; Captcha solver checkpoints disabled",
              file=sys.stderr)

    # GoLogin API token — required, read from env to support multi-worker
    # deployments without hardcoding secrets in the source.
    gologin_token = os.environ.get("GOLOGIN_API_TOKEN")
    if not gologin_token:
        print("[ERROR] GOLOGIN_API_TOKEN is not set in the environment", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    gl = GoLogin({
        "token": gologin_token,
        "profile_id": args.profile_id,
        "port": args.port,
    })

    # Defensive: close any active session for this profile before opening
    # a fresh one. Prevents Google from signing out when the profile is
    # already open in the GoLogin desktop app or held by a stale process.
    try:
        gl.stop()
    except Exception:
        pass
    time.sleep(3)

    for attempt in range(1, MAX_RETRIES + 1):
        driver = None
        try:
            # Step 1: Start GoLogin profile
            print(f"[INFO] Starting GoLogin profile (attempt {attempt}/{MAX_RETRIES})...")
            debugger_address = gl.start()
            print("[INFO] GoLogin profile started successfully.")
            time.sleep(2)

            # Step 2: Connect Selenium and check connectivity
            print("[INFO] Connecting to browser...")
            driver = connect_to_gologin_browser(debugger_address)

            # Hook turnstile.render before any page loads so Cloudflare
            # Challenge pages expose their solve params to the 2Captcha path.
            _install_turnstile_interceptor(driver)

            print("[INFO] Checking browser connectivity...")
            if not check_browser_connectivity(driver):
                raise Exception("Browser connectivity check failed - proxy may be unreachable")

            # Step 2.5: Google login state. If the profile is signed-out
            # (rotating IPs invalidate Google sessions) and we have
            # credentials in DB for this country, drive the sign-in
            # form. If Google throws 2FA / verify-it's-you / captcha,
            # escalate to a Captcha solver checkpoint with reason
            # 'google_login_required'. See ensure_google_login_if_required
            # for the full decision tree.
            #
            # Skip for Bing: Bing SERPs don't depend on a Google session.
            # Running this for Bing scrapes burned operator-attention on
            # an irrelevant Captcha solver session, and when nobody clicked Resume the
            # CAPTCHA_SOLVER_TIMEOUT marker leaked into stdout and caused
            # the worker to discard the otherwise-successful Bing scrape.
            if args.engine == "google":
                try:
                    ensure_google_login_if_required(driver)
                except InteractiveCancelException:
                    # Operator cancelled at the checkpoint — surface as a clean
                    # failure so the worker doesn't retry.
                    print("[INFO] google login: operator cancelled at Captcha solver checkpoint")
                    raise
                except Exception as exc:  # noqa: BLE001
                    # Login plumbing must never block scraping. If it crashes,
                    # log + continue — the scrape will still try; PPC may just
                    # be missing.
                    print(f"[WARN] google login: orchestrator crashed: {exc}", file=sys.stderr)

            # Step 3: Scrape — branch on engine. Both branches return the
            # same dict shape so save / webhook / final logging stays
            # engine-agnostic.
            if args.engine == "bing":
                data = scrape_bing_search(
                    driver,
                    args.keyword,
                    args.country,
                    max_pages=args.pages,
                    language=args.language,
                )
            else:
                data = scrape_google_search(
                    driver,
                    args.keyword,
                    args.country,
                    max_pages=args.pages,
                    language=args.language,
                    view_mode=args.view_mode,
                )

            save_to_file(data, args.output)

            if args.webhook:
                send_to_webhook(data, args.webhook)

            print(
                f"[DONE] {args.engine.upper()} | "
                f"Total: {data['total_results']} | "
                f"Organic: {data['organic_results']} | "
                f"PPC: {data['ppc_results']}"
            )

            print("[RESULT] SUCCESS")
            sys.exit(0)

        except CaptchaDetectedException as e:
            print(f"[WARN] {e}", file=sys.stderr)
            if driver:
                try:
                    driver.quit()
                except:
                    pass
            try:
                gl.stop()
            except:
                pass
            print("[RESULT] CAPTCHA")
            sys.exit(1)

        except zipfile.BadZipFile as e:
            # GoLogin's profile API returned non-zip data (rate-limit,
            # CDN blip, or an API JSON error). Distinct from a real
            # scrape failure — clear the half-written cache and back
            # off exponentially so the API has time to recover.
            print(f"[WARN] Attempt {attempt} hit GoLogin transient (BadZipFile): {e}",
                  file=sys.stderr)
            if driver:
                try:
                    driver.quit()
                except:
                    pass
            try:
                gl.stop()
            except:
                pass
            clear_gologin_tmp(args.profile_id)

            if attempt < MAX_RETRIES:
                backoff = BADZIP_BACKOFF_SECONDS[
                    min(attempt - 1, len(BADZIP_BACKOFF_SECONDS) - 1)
                ]
                print(f"[INFO] GoLogin transient — backing off {backoff}s before retry...")
                time.sleep(backoff)

        except Exception as e:
            print(f"[ERROR] Attempt {attempt} failed: {e}", file=sys.stderr)
            if driver:
                try:
                    driver.quit()
                except:
                    pass
            try:
                gl.stop()
            except:
                pass

            if attempt < MAX_RETRIES:
                print(f"[INFO] Retrying in 7 seconds...")
                time.sleep(7)

    print("[RESULT] FAILED")
    sys.exit(1)

if __name__ == "__main__":
    main()
