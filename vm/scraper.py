import os
import sys
import time
import json
import random
import argparse
import requests

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
# Deduplicate results by domain
# ---------------------------
def deduplicate_results(results):
    seen_domains = set()
    cleaned_results = []

    for r in results:
        domain = get_domain(r["url"])
        if domain not in seen_domains:
            seen_domains.add(domain)
            cleaned_results.append(r)
        else:
            print(f"[DEBUG] Skipping duplicate domain: {domain}")

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
CHECKPOINT_DEFAULT_TTL_MINUTES = 15

# Set by main() at startup. check_for_captcha falls back to these
# when callers don't pass kwargs explicitly. Keeps existing
# `check_for_captcha(driver)` callsites working unchanged.
#
# country_code + requires_google_login carry the per-country context
# that ensure_google_login_if_required() needs to look up credentials
# in the google_login_credentials table and decide whether a missing
# login should escalate to HITL.
_HITL_CTX: dict = {
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
    ttl_minutes: int = CHECKPOINT_DEFAULT_TTL_MINUTES,
) -> bool:
    """Pause the scrape and wait for an admin to resolve via noVNC.

    Returns True when the operator clicked Resume — the caller should
    re-check the page state and continue. Returns False when the
    checkpoint was cancelled or timed out — the caller should treat
    the wall as fatal (raise CaptchaDetectedException, etc).

    Requires --interactive + --job-id + --worker-id to actually fire;
    when called without them, returns False immediately so legacy
    callers fall through to their existing fail path.
    """
    if not job_id:
        print("[INFO] checkpoint: no --job-id, skipping (interactive flag ignored)")
        return False

    print(f"[INFO] checkpoint: pausing for human (reason={reason})")

    try:
        current_url = driver.current_url or None
    except Exception:  # noqa: BLE001
        current_url = None
    try:
        page_title = driver.title or None
    except Exception:  # noqa: BLE001
        page_title = None

    screenshot_path = _upload_checkpoint_screenshot(driver, job_id)

    # Insert the checkpoint row + flip scrape_queue status to needs_human
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

    print("[WARN] checkpoint timed out without operator action")
    return False


# ---------------------------
# Google auto-login (per-country credentials from DB + HITL fallback)
# ---------------------------
# When a GoLogin profile rotates IPs aggressively, Google server-side
# invalidates the session. We detect that on startup, fetch encrypted
# credentials from public.google_login_credentials via service-role RPC,
# and drive the sign-in form. If Google throws 2FA / verify-it's-you /
# captcha mid-login, we escalate to a HITL checkpoint with reason
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
    """Park the scrape at a HITL checkpoint with reason='google_login_required'.
    Returns True if the operator finished the login and the profile is now
    signed in, False otherwise. Raises InteractiveCancelException on cancel."""
    if not _HITL_CTX.get("interactive") or not _HITL_CTX.get("job_id"):
        print("[WARN] google login: HITL disabled, continuing without login",
              file=sys.stderr)
        return False
    resumed = request_interactive_checkpoint(
        driver,
        job_id=_HITL_CTX.get("job_id"),
        worker_id=_HITL_CTX.get("worker_id"),
        worker_port=_HITL_CTX.get("worker_port", 9222),
        reason="google_login_required",
        ttl_minutes=CHECKPOINT_DEFAULT_TTL_MINUTES,
    )
    country_code = _HITL_CTX.get("country_code")
    if not resumed:
        mark_google_login_used(country_code, "checkpoint_unresolved")
        return False
    # Operator clicked Resume — re-check state.
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
         - 'challenge' → escalate to HITL.
         - 'failed'    → stamp; if country requires login, escalate to HITL,
                         otherwise continue best-effort.
      4. Logged-out + NO creds ⇒ if country requires login, escalate to HITL,
         otherwise continue without login.
    """
    country_code = _HITL_CTX.get("country_code")
    requires_login = bool(_HITL_CTX.get("requires_google_login"))

    try:
        cur = driver.current_url or ""
    except Exception:  # noqa: BLE001
        cur = ""
    if "google.com" not in cur:
        try:
            driver.get("https://www.google.com")
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
            try:
                driver.get("https://www.google.com")
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
        print(f"[INFO] google login: no creds for {country_code} — escalating to HITL")
        _request_login_checkpoint(driver)
    else:
        print(f"[INFO] google login: no creds for {country_code} — continuing without login")


def check_for_captcha(driver, *, job_id=None, worker_id=None, worker_port=None, interactive=None):
    """Detect if Google is showing a CAPTCHA or unusual traffic page.

    When interactive=True AND --job-id is set, instead of raising we
    park the job at an interactive checkpoint and wait for an admin
    to click through via noVNC. After resume, re-check; if still
    captcha'd, fall through to the legacy raise.

    Falls back to module-level _HITL_CTX (set by main()) when
    kwargs aren't passed, so existing call sites don't need to be
    re-threaded.
    """
    if job_id is None:
        job_id = _HITL_CTX.get("job_id")
    if worker_id is None:
        worker_id = _HITL_CTX.get("worker_id")
    if worker_port is None:
        worker_port = _HITL_CTX.get("worker_port", 9222)
    if interactive is None:
        interactive = _HITL_CTX.get("interactive", False)
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

    if interactive and job_id:
        try:
            resumed = request_interactive_checkpoint(
                driver,
                job_id=job_id,
                worker_id=worker_id,
                worker_port=worker_port,
                reason="captcha",
            )
        except InteractiveCancelException:
            # Operator clicked Cancel — bubble out as captcha so the
            # worker logs / classifies the failure consistently.
            raise CaptchaDetectedException("operator cancelled at captcha checkpoint")
        if resumed and not _is_captcha():
            return
        # Either timed out or operator clicked Resume but the page
        # still shows captcha. Fall through to fail.

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


def _is_captcha_silent(driver) -> bool:
    """Cheap captcha check that does NOT escalate to HITL. Used by the
    mobile pass — if Google blocks the second request, we prefer to
    abort the mobile pass silently and preserve the already-saved
    desktop results, rather than freezing the whole scrape in HITL
    over an enhancement pass."""
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
def get_google_results_selenium(driver, keyword, country, page=0, language="en", wait_for_sponsored=True):
    start = page * 10
    encoded_keyword = quote_plus(keyword)
    url = f"https://www.google.com/search?q={encoded_keyword}&hl={language}&start={start}"

    print(f"[INFO] Navigating to: {url}")
    driver.get(url)

    check_for_captcha(driver)

    accept_google_consent(driver)

    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.ID, "search"))
        )
    except:
        print("[WARN] Search container not found")
        return []

    if wait_for_sponsored:
        wait_for_sponsored_results(driver, timeout=7)

    sponsored_map = extract_sponsored_urls_selenium(driver)
    sponsored_urls = set(sponsored_map.keys())

    # ONE click-through per PPC ad: real Ctrl+Click on the anchor,
    # wait up to 15s for the redirect chain to settle, scroll the
    # landing page to trigger lazy-loaded sections, then full-page
    # screenshot via CDP. Captures BOTH the resolved full URL (with
    # gclid + gad_*) and a screenshot of the uncloaked landing page
    # in one pass — half the time of the previous two-pass version
    # and gets a much more useful screenshot. PPC-only.
    serp_screenshots: dict = {}
    resolved_ppc_urls: dict = {}
    for idx, (ppc_url, anchor) in enumerate(sponsored_map.items()):
        out_path = f"/tmp/serp_ad_{int(time.time() * 1000)}_{page}_{idx}.png"
        full, shot = click_through_ppc(driver, anchor, out_path)
        if full:
            resolved_ppc_urls[ppc_url] = full
            print(f"[DEBUG] Resolved PPC URL: {ppc_url} → {full}")
        if shot:
            serp_screenshots[ppc_url] = out_path

    soup = BeautifulSoup(driver.page_source, "html.parser")
    results = []
    position = 1
    overall_position = 1

    # --- Organic results ---
    for h3 in soup.select("#search a h3"):
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
def scrape_google_search(driver, keyword, country, max_pages=5, delay_min=2, delay_max=5, language="en", mobile_pass=True):
    all_results = []
    login_state = None

    for page in range(max_pages):
        page_results = get_google_results_selenium(driver, keyword, country, page, language=language)
        # Stamp every desktop-pass row up front. The mobile pass below
        # flips overlapping rows to 'both' and tags new ones as 'mobile'.
        for r in page_results:
            r["seen_on"] = "desktop"
        all_results.extend(page_results)

        # Capture the login state from the first successfully loaded page.
        # All pages of a single scrape share one session so checking once
        # is enough — and we do it on page 1 specifically because later
        # pages may have different layouts (results, no header avatar).
        if page == 0:
            login_state = detect_login_state(driver)
            print(f"[INFO] Login-state detected: {login_state}")

        if page < max_pages - 1:
            time.sleep(random.uniform(delay_min, delay_max))

    # ----- Mobile-only PPC pass -----
    # Switches the tab to iPhone UA + 375x812 via CDP, re-fetches page 0,
    # extracts sponsored URLs, and merges any not already in the desktop
    # set. Mobile pass aborts gracefully on captcha (does NOT escalate to
    # HITL) so an enhancement failure can never wipe the desktop results.
    mobile_summary = {"new": 0, "both": 0, "skipped_reason": None}
    if mobile_pass:
        try:
            mobile_ppc = scrape_google_mobile_ppc(driver, keyword, country, language=language)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Mobile pass failed: {exc} — desktop results preserved", file=sys.stderr)
            mobile_ppc = None
            mobile_summary["skipped_reason"] = "exception"

        if mobile_ppc is None:
            mobile_summary["skipped_reason"] = mobile_summary["skipped_reason"] or "captcha_or_skip"
        elif mobile_ppc:
            existing_urls = {r["url"] for r in all_results}
            existing_full = {r.get("full_url") for r in all_results if r.get("full_url")}
            for mr in mobile_ppc:
                # If we already have this URL from the desktop pass, just
                # promote the existing row to seen_on='both' — don't emit
                # a duplicate.
                overlap = next(
                    (r for r in all_results
                     if r["url"] == mr["url"]
                     or (r.get("full_url") and r["full_url"] == mr.get("full_url"))),
                    None,
                )
                if overlap is not None:
                    overlap["seen_on"] = "both"
                    mobile_summary["both"] += 1
                    continue
                mr["seen_on"] = "mobile"
                all_results.append(mr)
                existing_urls.add(mr["url"])
                if mr.get("full_url"):
                    existing_full.add(mr["full_url"])
                mobile_summary["new"] += 1
        print(
            f"[INFO] Mobile pass merged: {mobile_summary['new']} new "
            f"mobile-only PPC, {mobile_summary['both']} cross-device "
            f"(also seen on desktop)"
        )

    # Deduplicate by domain before returning
    all_results = deduplicate_results(all_results)

    return {
        "params": {
            "keyword": keyword,
            "country": country
        },
        "total_results": len(all_results),
        "organic_results": sum(r["resultType"] == "Organic" for r in all_results),
        "ppc_results": sum(r["resultType"] == "PPC" for r in all_results),
        "mobile_only_ppc": mobile_summary["new"],
        "cross_device_ppc": mobile_summary["both"],
        "mobile_pass_skipped": mobile_summary["skipped_reason"],
        "pages_scraped": max_pages,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": login_state,
        "results": all_results
    }


def scrape_google_mobile_ppc(driver, keyword, country, language="en"):
    """Mobile-only PPC pass. Run AFTER scrape_google_search has finished
    its desktop loop — switches the driver to iPhone UA + 375x812 viewport
    via CDP, re-fetches page 0 of the Google SERP, and returns ONLY the
    PPC result rows (organic results are intentionally not re-parsed —
    they don't differ meaningfully between devices and a second parse
    just buys captcha exposure for no benefit).

    Returns:
      list[dict] of PPC result rows — same shape as scrape_google_search
        emits, but without seen_on set (caller stamps that based on the
        desktop-pass overlap)
      None — pass aborted (captcha, profile error, etc.). Caller should
        keep the desktop results and move on.
    """
    if not _set_mobile_viewport(driver):
        return None

    # Small gap before re-firing the same SERP URL so the second request
    # doesn't slam Google's bot detection from the same profile in <1s.
    time.sleep(random.uniform(2.5, 4.5))

    encoded_keyword = quote_plus(keyword)
    url = f"https://www.google.com/search?q={encoded_keyword}&hl={language}&start=0"
    print(f"[INFO] Mobile pass: navigating to {url}")

    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] Mobile pass: navigation failed: {exc}", file=sys.stderr)
        return None

    if _is_captcha_silent(driver):
        print("[WARN] Mobile pass: captcha detected on mobile request — aborting silently")
        return None

    accept_google_consent(driver)

    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.ID, "search"))
        )
    except Exception:  # noqa: BLE001
        print("[WARN] Mobile pass: search container not found — aborting")
        return None

    wait_for_sponsored_results(driver, timeout=10)

    sponsored_map = extract_sponsored_urls_selenium(driver)
    sponsored_urls = list(sponsored_map.keys())
    if not sponsored_urls:
        print("[INFO] Mobile pass: no sponsored URLs found")
        return []

    print(f"[INFO] Mobile pass: found {len(sponsored_urls)} sponsored URL(s) — resolving")

    # Click through each PPC to capture the full URL (gclid/gad_*) and
    # full-page landing screenshot, same as the desktop pass does. We
    # skip click-throughs for ads we already saw on desktop because the
    # caller will dedupe by URL anyway and we'd waste navigations.
    serp_screenshots: dict = {}
    resolved_ppc_urls: dict = {}
    for idx, (ppc_url, anchor) in enumerate(sponsored_map.items()):
        out_path = f"/tmp/serp_ad_mobile_{int(time.time() * 1000)}_{idx}.png"
        try:
            full, shot = click_through_ppc(driver, anchor, out_path)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Mobile pass: click-through failed for ad {idx}: {exc}",
                  file=sys.stderr)
            continue
        if full:
            resolved_ppc_urls[ppc_url] = full
        if shot:
            serp_screenshots[ppc_url] = out_path

    soup = BeautifulSoup(driver.page_source, "html.parser")
    results = []
    for ppc_url in sponsored_urls:
        resolved = resolved_ppc_urls.get(ppc_url, ppc_url)
        a_tag = soup.find("a", href=ppc_url) or soup.find("a", {"data-pcu": ppc_url})
        title = a_tag.get_text(strip=True) if a_tag else ""

        parsed = urlparse(ppc_url)
        full_url = f"{parsed.scheme}://{parsed.netloc}"

        result_row = {
            "url": resolved,
            "full_url": full_url,
            "title": title,
            "resultType": "PPC",
            "page": 1,  # mobile pass only re-fetches page 0
            "position": None,
            "overall_position": None,
            "keyword": keyword,
            "country": country,
        }
        if ppc_url in serp_screenshots:
            result_row["local_serp_screenshot"] = serp_screenshots[ppc_url]
        results.append(result_row)

    return results

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

    # Bing now serves a JavaScript-rendered shell — page_source captured
    # right after navigation has 0 result links because the result blocks
    # (`[data-bm]` markers) hydrate from JS later. Wait for actual
    # external links to populate, force lazy rendering with a scroll,
    # then re-grab page_source. Up to 35s total.
    #
    # We don't wait for a specific container ID anymore (Bing has
    # rotated through `b_results`, `b_content`, and several others).
    # We wait for the result CONTENT to actually exist — at least 5
    # outbound `<a>` tags pointing to non-bing/microsoft domains.

    def _outbound_link_count(d):
        try:
            return d.execute_script("""
                var anchors = document.querySelectorAll('a[href^="http"]');
                var count = 0;
                for (var i = 0; i < anchors.length; i++) {
                  var h = anchors[i].href.toLowerCase();
                  if (h.indexOf('bing.com') === -1
                      && h.indexOf('microsoft.com') === -1
                      && h.indexOf('msn.com') === -1
                      && h.indexOf('live.com') === -1) {
                    count++;
                    if (count >= 5) return count;
                  }
                }
                return count;
            """)
        except Exception:
            return 0

    deadline = time.time() + 35
    scrolled = False
    while time.time() < deadline:
        if _outbound_link_count(driver) >= 5:
            break
        # Halfway through, force a scroll to trigger any lazy hydration.
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

    # Final settle — even if links exist, give Bing a moment to finish.
    time.sleep(2)

    page_source = driver.page_source
    landed_url = driver.current_url
    print(f"[INFO] Bing landed URL: {landed_url}")
    _maybe_save_bing_debug(page_source, landed_url)
    soup = BeautifulSoup(page_source, "html.parser")
    # Crude size sanity check — if the page is suspiciously small, we
    # probably hit a consent banner / interstitial / redirect rather
    # than a real SERP.
    if len(page_source) < 5000:
        print(f"[WARN] Bing page_source is only {len(page_source)} bytes — likely an interstitial")
    final_link_count = _outbound_link_count(driver)
    print(f"[DEBUG] Bing final outbound-link count: {final_link_count}")
    if final_link_count == 0:
        print(
            "[WARN] Bing returned a JS-only shell (no result links rendered). "
            "Likely server-side bot detection on this proxy/fingerprint combination."
        )
        return []
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
        href = a.get("href")
        if href in seen_hrefs:
            continue
        title = a.get_text(strip=True)
        if not title:
            continue
        seen_hrefs.add(href)
        parsed = urlparse(href)
        full_url = f"{parsed.scheme}://{parsed.netloc}"
        results.append({
            "url": href,
            "full_url": full_url,
            "title": title,
            "resultType": "PPC",
            "page": page + 1,
            "position": None,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country,
        })
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
        href = a.get("href")
        if not href or href in seen_hrefs:
            continue
        # Bing internal links (e.g. /search redirects, image carousels)
        # aren't real organic results — drop them.
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
            href = a.get("href")
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
        driver.get("https://www.google.com")
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

def main():
    parser = argparse.ArgumentParser(
        description="Start GoLogin profile and scrape Google or Bing search results"
    )

    parser.add_argument("profile_id", help="GoLogin profile ID")
    parser.add_argument("-k", "--keyword", required=True, help="Search keyword")
    parser.add_argument("-c", "--country", required=True, help="Country display name (e.g. 'Germany')")
    parser.add_argument("--country-code", default=None, help="2-letter ISO country code (e.g. 'DE'). Used to look up Google login credentials.")
    parser.add_argument("--requires-google-login", action="store_true", help="Treat this country as requires_google_login=true. When set, a logged-out profile escalates to HITL if no creds are configured.")
    parser.add_argument("--pages", type=int, default=10, help="Number of pages to scrape")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (must be unique per concurrent worker)")
    parser.add_argument("--output", default="/tmp/google_results.json", help="Path to write the results JSON")
    parser.add_argument("--webhook", default=None, help="Optional webhook URL to POST results to (not used by the Supabase worker)")
    parser.add_argument("--language", default="en", help="Search language code (en, ar, de, …)")
    parser.add_argument("--engine", default="google", choices=["google", "bing"], help="Which search engine to scrape")
    parser.add_argument(
        "--mobile-pass",
        dest="mobile_pass",
        action="store_true",
        default=True,
        help="After the desktop SERP scrape completes, re-fetch page 0 of Google with iPhone UA + 375x812 viewport via CDP and merge any mobile-only PPC ads (default: on). Aborts silently on captcha — desktop results are preserved.",
    )
    parser.add_argument(
        "--no-mobile-pass",
        dest="mobile_pass",
        action="store_false",
        help="Disable the mobile PPC pass for this scrape (e.g. on a captcha-prone country).",
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
    _HITL_CTX["job_id"] = args.job_id
    _HITL_CTX["worker_id"] = args.worker_id
    _HITL_CTX["worker_port"] = args.port
    _HITL_CTX["interactive"] = bool(args.interactive)
    _HITL_CTX["country_code"] = (args.country_code or "").strip().upper() or None
    _HITL_CTX["requires_google_login"] = bool(args.requires_google_login)
    if args.interactive and not args.job_id:
        print("[WARN] --interactive set without --job-id; HITL checkpoints disabled",
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

            print("[INFO] Checking browser connectivity...")
            if not check_browser_connectivity(driver):
                raise Exception("Browser connectivity check failed - proxy may be unreachable")

            # Step 2.5: Google login state. If the profile is signed-out
            # (rotating IPs invalidate Google sessions) and we have
            # credentials in DB for this country, drive the sign-in
            # form. If Google throws 2FA / verify-it's-you / captcha,
            # escalate to a HITL checkpoint with reason
            # 'google_login_required'. See ensure_google_login_if_required
            # for the full decision tree.
            try:
                ensure_google_login_if_required(driver)
            except InteractiveCancelException:
                # Operator cancelled at the checkpoint — surface as a clean
                # failure so the worker doesn't retry.
                print("[INFO] google login: operator cancelled at HITL checkpoint")
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
                    mobile_pass=args.mobile_pass,
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
