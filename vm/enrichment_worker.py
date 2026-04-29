#!/usr/bin/env python3
"""
Enrichment fetch worker. Runs forever under systemd on the AWS VM.

Polls Supabase claim_enrichment_fetch_job() every POLL_INTERVAL_SECONDS;
for each claimed row it:
  - looks up the country's GoLogin profile (so the fetch happens from the
    same country that revealed the SERP result — important for PPC ads)
  - opens the URL in Chromium
  - dumps the rendered page source into fetched_html_cache
  - if want_screenshot: takes a full-page PNG, uploads to the
    'lead-screenshots' Supabase Storage bucket
  - calls complete_enrichment_fetch_job (atomic: cache + screenshot link
    + status + lock release)
  - hits the Vercel /api/enrichment/score-row endpoint once per
    process_stages entry to do inline scoring (affiliate / rooster /
    contact / stag) so the user sees results without a second click

Designed to run multiple instances per VM — each on a different
GOLOGIN_PORT. Recommended ports 9225/9226/9227 to avoid colliding with
the scrape workers on 9222–9224.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from typing import Any

import json as _json
import re
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from gologin import GoLogin
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
WORKER_ID            = os.environ["WORKER_ID"]
GOLOGIN_PORT         = int(os.environ.get("GOLOGIN_PORT", "9225"))
POLL_INTERVAL        = int(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
PAGE_LOAD_TIMEOUT_S  = int(os.environ.get("PAGE_LOAD_TIMEOUT_SECONDS", "25"))
PAGE_SETTLE_S        = int(os.environ.get("PAGE_SETTLE_SECONDS", "3"))
SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_KEY         = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
GOLOGIN_TOKEN        = os.environ["GOLOGIN_API_TOKEN"]
APP_URL              = os.environ["APP_URL"].rstrip("/")
INTERNAL_API_TOKEN   = os.environ["INTERNAL_API_TOKEN"]
SCREENSHOT_BUCKET    = os.environ.get("SCREENSHOT_BUCKET", "lead-screenshots")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(WORKER_ID)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
_running = True


def _handle_signal(sig: int, _frame: Any) -> None:
    global _running
    log.info("signal %d received — finishing iteration then stopping", sig)
    _running = False


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


# ---------------------------------------------------------------------------
# Supabase RPC helpers
# ---------------------------------------------------------------------------

def claim_job() -> dict[str, Any] | None:
    res = supabase.rpc(
        "claim_enrichment_fetch_job", {"p_worker_id": WORKER_ID}
    ).execute()
    return res.data if res.data else None


def complete_job(job_id: str, html: str | None, screenshot_path: str | None,
                 fetch_error: str | None) -> None:
    supabase.rpc(
        "complete_enrichment_fetch_job",
        {
            "p_job_id": job_id,
            "p_html": html,
            "p_screenshot_path": screenshot_path,
            "p_fetch_error": fetch_error,
        },
    ).execute()


def fail_job(job_id: str, error: str) -> None:
    supabase.rpc(
        "fail_enrichment_fetch_job",
        {"p_job_id": job_id, "p_error": error[:2000]},
    ).execute()


def fetch_profile(country_code: str) -> dict[str, Any] | None:
    res = (
        supabase.table("gologin_profiles")
        .select("gologin_profile_id, country_name")
        .eq("country_code", country_code)
        .single()
        .execute()
    )
    return res.data


def upload_screenshot(lead_id: int, png_bytes: bytes, suffix: str = "") -> str | None:
    """Upload a screenshot to lead-screenshots Storage. Returns the object path."""
    tag = suffix or f"lead_{lead_id}_{int(time.time() * 1000)}"
    safe_tag = re.sub(r"[^A-Za-z0-9._-]", "_", tag)
    path = f"lead_{lead_id}/{safe_tag}.png"
    try:
        supabase.storage.from_(SCREENSHOT_BUCKET).upload(
            path,
            png_bytes,
            {"content-type": "image/png", "upsert": "true"},
        )
        return path
    except Exception as exc:  # noqa: BLE001
        log.warning("screenshot upload failed for lead %s: %s", lead_id, exc)
        return None


def process_stag_in_browser(
    driver: webdriver.Chrome,
    lead_id: int,
    url: str,
) -> list[dict]:
    """
    End-to-end s-tag extraction in one browser session.

      1. Load homepage, find casino-listing pages (Option 4)
      2. Visit up to MAX_EXTRA_PAGES of them
      3. Extract tracking links from every visited page (3-path) — Option 3
      4. For each tracking link, navigate in browser, capture final URL +
         redirect chain + screenshot — Options 2 + 5
      5. Parse [btag, stag, cxd, mid, affid] from the final URL
      6. Return deduped tags as a list of dicts ready for the RPC

    Heavy on browser navigations — count one per tracking link plus N+1
    page loads. Relies on the country lock to stay single-occupant.
    """
    home_html = _navigate(driver, url)
    if not home_html:
        return []

    pages_html: list[tuple[str, str]] = [(url, home_html)]
    for extra_url in _pick_stag_pages(home_html, url):
        chunk = _navigate(driver, extra_url, settle_s=2)
        if chunk:
            pages_html.append((extra_url, chunk))

    seen_tracking: set[str] = set()
    for page_url, page_html in pages_html:
        for link in extract_tracking_links(page_html, page_url):
            seen_tracking.add(link)

    if not seen_tracking:
        log.info("stag: lead=%s no tracking links found across %d pages",
                 lead_id, len(pages_html))
        return []

    log.info("stag: lead=%s found %d tracking links across %d pages",
             lead_id, len(seen_tracking), len(pages_html))

    resolved_by_tag: dict[str, dict] = {}
    for i, tracking_url in enumerate(list(seen_tracking)[:30]):
        final_url, chain, screenshot = resolve_in_browser(driver, tracking_url)
        if not final_url:
            continue
        parsed = parse_stag_from_url(final_url)
        if not parsed:
            continue
        tag_value, source_param = parsed
        if tag_value in resolved_by_tag:
            continue
        screenshot_path: str | None = None
        if screenshot:
            screenshot_path = upload_screenshot(
                lead_id, screenshot, suffix=f"stag_{i}_{int(time.time() * 1000)}",
            )
        resolved_by_tag[tag_value] = {
            "s_tag": tag_value,
            "source_param": source_param,
            "brand": guess_brand_from_url(final_url),
            "tracking_url": tracking_url,
            "final_url": final_url,
            "redirect_chain": chain,
            "screenshot_path": screenshot_path,
        }

    return list(resolved_by_tag.values())


def call_score_endpoint(lead_id: int, stage: str, extras: dict | None = None) -> None:
    body = {"lead_id": lead_id, "stage": stage}
    if extras is not None:
        body["extras"] = extras
    try:
        r = requests.post(
            f"{APP_URL}/api/enrichment/score-row",
            json=body,
            headers={
                "Authorization": f"Bearer {INTERNAL_API_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=60,
        )
        if r.status_code >= 400:
            log.warning(
                "score-row %s returned %s for lead %s: %s",
                stage, r.status_code, lead_id, r.text[:300],
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("score-row call failed for lead %s/%s: %s", lead_id, stage, exc)


# ---------------------------------------------------------------------------
# Browser
# ---------------------------------------------------------------------------

def connect_chrome(debugger_address: str) -> webdriver.Chrome:
    opts = webdriver.ChromeOptions()
    opts.add_experimental_option("debuggerAddress", debugger_address)
    service = Service("/usr/local/bin/chromedriver")
    return webdriver.Chrome(service=service, options=opts)


CONTACT_LINK_RE = re.compile(
    r'href=["\']([^"\']*\b(?:contact|kontakt|about|impressum)\b[^"\']*)["\']',
    re.IGNORECASE,
)
CONTACT_PATH_FALLBACKS = ("/contact", "/contact-us", "/about", "/about-us", "/impressum")

# S-tag stage looks for casino-listing pages where tracking links live
STAG_LIST_LINK_RE = re.compile(
    r'href=["\']([^"\']*\b(?:casinos?|reviews?|best|top[\d\-]*|list|comparison|guide|toplist)\b[^"\']*)["\']',
    re.IGNORECASE,
)
STAG_PATH_FALLBACKS = (
    "/casinos", "/best-casinos", "/top-casinos", "/reviews",
    "/casino-reviews", "/best", "/top-10",
)

MAX_EXTRA_PAGES = 5

# ----- s-tag link extraction (3-path) -----
ANCHOR_HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
DATA_ATTR_RE = re.compile(
    r'\bdata-(?:href|url|redirect|link|track|destination|out|outlink|target)=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
ONCLICK_NAV_RE = re.compile(
    r'onclick=["\'][^"\']*?(?:window\.location|location\.href|location\.replace)\s*=\s*["\']([^"\']+)["\']',
    re.IGNORECASE,
)
NEXT_DATA_RE = re.compile(
    r'<script[^>]*?id=["\']__NEXT_DATA__["\'][^>]*?>([\s\S]*?)</script>',
    re.IGNORECASE,
)
NEXT_DATA_KEYS = {
    "claimurl", "affiliateurl", "offerurl", "trackingurl", "clickurl",
    "bonusurl", "dealurl", "gourl", "visiturl", "ctaurl", "outlink",
    "redirecturl", "playurl", "signupurl", "registerurl",
}

TRACKING_PATH_RE = re.compile(
    r"/(track|click|go|visit|out|redirect|creat|aff|ref|link|offer|bonus|promo)/",
    re.IGNORECASE,
)
TRACKING_QUERY_RE = re.compile(
    r"[?&](ref|aff|affiliate|campaign|source|tracking|click)=",
    re.IGNORECASE,
)

EXCLUDED_HOSTS = {
    "youtube.com", "youtu.be", "facebook.com", "twitter.com", "x.com",
    "instagram.com", "tiktok.com", "reddit.com", "linkedin.com",
    "pinterest.com", "wikipedia.org",
}

STAG_PARAM_ORDER = ("btag", "stag", "cxd", "mid", "affid")


def _is_tracking_link(url: str) -> bool:
    if not url:
        return False
    if url.startswith("#") or url.startswith("javascript:") or url.startswith("mailto:") or url.startswith("tel:"):
        return False
    if not (TRACKING_PATH_RE.search(url) or TRACKING_QUERY_RE.search(url)):
        return False
    return True


def _walk_next_data(obj):
    """Recursively yield string values whose key matches our tracking-key list."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and isinstance(k, str) and k.lower() in NEXT_DATA_KEYS:
                yield v
            elif isinstance(v, (dict, list)):
                yield from _walk_next_data(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_next_data(item)


def extract_tracking_links(html: str, base_url: str) -> list[str]:
    """
    Three-path tracking-link extraction (catalog-faithful port):
      1. <a href> attributes
      2. data-* attributes + onclick navigation patterns
      3. Next.js __NEXT_DATA__ JSON walk for known tracking keys
    Returns absolute URLs (deduped, capped, same-host filtered).
    """
    if not html or len(html) < 100:
        return []

    try:
        base_host = urlparse(base_url).netloc.lower().lstrip("www.")
    except Exception:  # noqa: BLE001
        base_host = ""

    found: set[str] = set()

    def _consider(raw: str) -> None:
        if not _is_tracking_link(raw):
            return
        try:
            absolute = urljoin(base_url, raw)
            host = urlparse(absolute).netloc.lower().replace("www.", "")
        except Exception:  # noqa: BLE001
            return
        if not host or host == base_host or host in EXCLUDED_HOSTS:
            return
        found.add(absolute)

    # Path 1
    for m in ANCHOR_HREF_RE.finditer(html):
        _consider(m.group(1))
    # Path 2
    for m in DATA_ATTR_RE.finditer(html):
        _consider(m.group(1))
    for m in ONCLICK_NAV_RE.finditer(html):
        _consider(m.group(1))
    # Path 3 — __NEXT_DATA__
    next_match = NEXT_DATA_RE.search(html)
    if next_match:
        try:
            payload = _json.loads(next_match.group(1))
            for raw in _walk_next_data(payload):
                if isinstance(raw, str):
                    _consider(raw)
        except Exception:  # noqa: BLE001
            pass

    return list(found)[:30]


def parse_stag_from_url(url: str) -> tuple[str, str] | None:
    """Return (tag_value, source_param) for the FIRST matching key, in priority order."""
    try:
        qs = parse_qs(urlparse(url).query, keep_blank_values=False)
    except Exception:  # noqa: BLE001
        return None
    # parse_qs is case-sensitive on keys; build a case-insensitive view.
    lower_qs = {k.lower(): v for k, v in qs.items()}
    for key in STAG_PARAM_ORDER:
        v = lower_qs.get(key)
        if v and v[0]:
            return v[0], key
    return None


def guess_brand_from_url(url: str) -> str | None:
    try:
        host = urlparse(url).netloc.lower().replace("www.", "")
        parts = host.split(".")
        if len(parts) < 2:
            return None
        return ".".join(parts[:-1]) or None
    except Exception:  # noqa: BLE001
        return None


def _navigate(driver: webdriver.Chrome, url: str, settle_s: int = PAGE_SETTLE_S) -> str | None:
    """Navigate + return page_source, or None on failure."""
    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        log.debug("nav %s failed: %s", url, exc)
        return None
    try:
        WebDriverWait(driver, PAGE_LOAD_TIMEOUT_S).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
    except Exception:  # noqa: BLE001
        pass
    time.sleep(settle_s)
    try:
        return driver.page_source
    except Exception:  # noqa: BLE001
        return None


def _pick_pages(
    html: str,
    base_url: str,
    link_re: re.Pattern,
    fallbacks: tuple[str, ...],
    max_pages: int,
) -> list[str]:
    """Find same-host pages matching link_re; fall back to known paths."""
    if not html:
        candidates = []
    else:
        candidates = []
        seen: set[str] = set()
        for m in link_re.finditer(html):
            href = m.group(1)
            if not href:
                continue
            try:
                absolute = urljoin(base_url, href)
            except Exception:  # noqa: BLE001
                continue
            if absolute in seen:
                continue
            seen.add(absolute)
            try:
                if urlparse(absolute).netloc != urlparse(base_url).netloc:
                    continue
            except Exception:  # noqa: BLE001
                continue
            candidates.append(absolute)
            if len(candidates) >= max_pages:
                break
    if candidates:
        return candidates
    out: list[str] = []
    for path in fallbacks[:max_pages]:
        try:
            out.append(urljoin(base_url, path))
        except Exception:  # noqa: BLE001
            continue
    return out


def _pick_contact_pages(html: str, base_url: str) -> list[str]:
    return _pick_pages(html, base_url, CONTACT_LINK_RE, CONTACT_PATH_FALLBACKS, 3)


def _pick_stag_pages(html: str, base_url: str) -> list[str]:
    return _pick_pages(html, base_url, STAG_LIST_LINK_RE, STAG_PATH_FALLBACKS, MAX_EXTRA_PAGES)


def resolve_in_browser(driver: webdriver.Chrome, tracking_url: str
                       ) -> tuple[str | None, list[str], bytes | None]:
    """
    Open a tracking URL in the GoLogin browser, follow all redirects,
    return (final_url, chain_steps, screenshot_bytes_of_final_page).
    Same country profile = correct geo-routed redirect.
    """
    chain = [tracking_url]
    try:
        driver.set_page_load_timeout(20)
    except Exception:  # noqa: BLE001
        pass
    try:
        driver.get(tracking_url)
    except Exception as exc:  # noqa: BLE001
        log.debug("redirect-resolve nav failed: %s", exc)
        return None, chain, None
    time.sleep(2)
    try:
        final_url = driver.current_url
    except Exception:  # noqa: BLE001
        return None, chain, None
    if final_url and final_url != tracking_url:
        chain.append(final_url)
    # Best-effort screenshot for audit trail
    screenshot: bytes | None = None
    try:
        screenshot = driver.get_screenshot_as_png()
    except Exception:  # noqa: BLE001
        pass
    return final_url, chain, screenshot


def fetch_with_browser(
    profile_id: str,
    url: str,
    want_screenshot: bool,
    multi_page: bool = False,
) -> tuple[str | None, bytes | None, str | None]:
    """Open URL in the GoLogin profile, return (html, screenshot_bytes, error).

    If multi_page=True, also navigates to up to MAX_EXTRA_PAGES contact-shaped
    links on the homepage and concatenates their HTML into one blob (with
    page-break markers) so the score-row endpoint can extract from all of them.
    """
    gl = GoLogin({"token": GOLOGIN_TOKEN, "profile_id": profile_id, "port": GOLOGIN_PORT})
    driver = None
    try:
        debugger = gl.start()
        time.sleep(2)
        driver = connect_chrome(debugger)
        driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT_S)

        homepage = _navigate(driver, url)
        if homepage is None:
            return None, None, "navigation failed on homepage"

        screenshot_bytes: bytes | None = None
        if want_screenshot:
            try:
                screenshot_bytes = driver.get_screenshot_as_png()
            except Exception as exc:  # noqa: BLE001
                log.warning("screenshot capture failed: %s", exc)

        if not multi_page:
            return homepage, screenshot_bytes, None

        chunks = [f"<!-- PAGE: {url} -->", homepage]
        for extra in _pick_contact_pages(homepage, url):
            extra_html = _navigate(driver, extra, settle_s=2)
            if extra_html:
                chunks.append(f"<!-- PAGE: {extra} -->")
                chunks.append(extra_html)

        return "\n".join(chunks), screenshot_bytes, None
    except Exception as exc:  # noqa: BLE001
        return None, None, str(exc)
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass
        try:
            gl.stop()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Job processing
# ---------------------------------------------------------------------------

def process_job(job: dict[str, Any]) -> None:
    job_id        = job["id"]
    lead_id       = int(job["lead_id"])
    country_code  = job["country_code"]
    url           = job["url"]
    want_html     = bool(job.get("want_html", True))
    want_screenshot = bool(job.get("want_screenshot", False))
    process_stages = job.get("process_stages") or []
    if isinstance(process_stages, str):
        try:
            process_stages = json.loads(process_stages)
        except Exception:  # noqa: BLE001
            process_stages = []

    log.info(
        "claimed enrichment job %s | lead=%s country=%s url=%s screenshot=%s stages=%s",
        job_id, lead_id, country_code, url[:80], want_screenshot, process_stages,
    )

    profile = fetch_profile(country_code)
    if not profile or not profile.get("gologin_profile_id"):
        complete_job(
            job_id, None, None,
            f"No gologin_profile_id configured for country={country_code}",
        )
        return

    multi_page = "contact" in process_stages
    has_stag = "stag" in process_stages
    has_rooster_deep = "rooster_deep" in process_stages

    # Rooster-deep is a browser-side fallback when the cheap HTML
    # href-check missed brand links hidden behind tracking redirects.
    # Owns its own browser session (no HTML cache write, no screenshots);
    # ships the resolved final URLs to score-row which decides match/no-match.
    if has_rooster_deep:
        resolved = run_rooster_deep_session(
            profile["gologin_profile_id"],
            lead_id,
            url,
        )
        complete_job(job_id, None, None, None)
        call_score_endpoint(
            lead_id,
            "rooster_deep",
            extras={"resolved_urls": resolved},
        )
        log.info(
            "enrichment job %s done (rooster_deep) | resolved=%d",
            job_id, len(resolved),
        )
        return

    # When stag is involved we own the browser session for the full
    # extract+resolve loop, so we run a richer flow that does multi-page
    # crawl + redirect resolution + screenshots inside the same Chromium.
    if has_stag:
        ok, err, html_for_cache, png, stag_results = run_full_browser_session(
            profile["gologin_profile_id"],
            lead_id,
            url,
            want_screenshot,
        )
        screenshot_path: str | None = None
        if png is not None:
            screenshot_path = upload_screenshot(lead_id, png)
        complete_job(
            job_id,
            html_for_cache if want_html else None,
            screenshot_path,
            err,
        )
        # Push resolved tags into score-row so it can call the RPC.
        if ok and stag_results is not None:
            call_score_endpoint(lead_id, "stag", extras={"tags": stag_results})
        # Other stages (if combined) read from cache as usual.
        for stage in process_stages:
            if stage == "stag":
                continue
            if isinstance(stage, str) and stage:
                call_score_endpoint(lead_id, stage)
        log.info(
            "enrichment job %s done (stag) | err=%s tags=%d screenshot=%s",
            job_id, err, len(stag_results or []), screenshot_path,
        )
        return

    # Vanilla flow: single homepage fetch (+ multi-page for contact)
    html, png, err = fetch_with_browser(
        profile["gologin_profile_id"], url, want_screenshot, multi_page,
    )
    screenshot_path = None
    if png is not None:
        screenshot_path = upload_screenshot(lead_id, png)
    complete_job(
        job_id,
        html if want_html else None,
        screenshot_path,
        err,
    )
    for stage in process_stages:
        if not isinstance(stage, str) or not stage:
            continue
        call_score_endpoint(lead_id, stage)
    log.info("enrichment job %s done | err=%s screenshot=%s", job_id, err, screenshot_path)


def run_rooster_deep_session(
    profile_id: str,
    lead_id: int,
    url: str,
) -> list[str]:
    """
    Browser-resolved fallback for the Rooster check.

    Opens the lead URL in the country profile, runs the same 3-path
    tracking-link extraction the s-tag stage uses, then follows each
    tracking link in Chromium and collects the final URL. No s-tag
    parsing, no screenshots, no HTML cache write — score-row will
    just check the returned URLs against the brand list.

    Capped at 30 tracking links per page to stay under reasonable
    runtime when an aggregator page links to dozens of casinos.
    """
    gl = GoLogin({"token": GOLOGIN_TOKEN, "profile_id": profile_id, "port": GOLOGIN_PORT})
    driver = None
    resolved: list[str] = []
    try:
        debugger = gl.start()
        time.sleep(2)
        driver = connect_chrome(debugger)
        driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT_S)

        page_html = _navigate(driver, url)
        if page_html is None:
            log.info("rooster_deep: lead=%s navigation failed", lead_id)
            return []

        seen: set[str] = set()
        for link in extract_tracking_links(page_html, url):
            seen.add(link)
        if not seen:
            log.info("rooster_deep: lead=%s no tracking links to resolve", lead_id)
            return []

        log.info("rooster_deep: lead=%s resolving %d tracking links",
                 lead_id, len(seen))
        for tracking_url in list(seen)[:30]:
            final_url, _chain, _screenshot = resolve_in_browser(driver, tracking_url)
            if final_url:
                resolved.append(final_url)
        # Dedup while preserving order
        return list(dict.fromkeys(resolved))
    except Exception as exc:  # noqa: BLE001
        log.warning("rooster_deep: lead=%s failed: %s", lead_id, exc)
        return resolved
    finally:
        try:
            if driver is not None:
                driver.quit()
        except Exception:  # noqa: BLE001
            pass
        try:
            gl.stop()
        except Exception:  # noqa: BLE001
            pass


def run_full_browser_session(
    profile_id: str,
    lead_id: int,
    url: str,
    want_screenshot: bool,
) -> tuple[bool, str | None, str | None, bytes | None, list[dict] | None]:
    """
    One Chromium session covering both the homepage HTML cache write
    AND the s-tag multi-page extract + redirect resolve flow.

    Returns (ok, error, html_for_cache, homepage_png, resolved_stags).
    """
    gl = GoLogin({"token": GOLOGIN_TOKEN, "profile_id": profile_id, "port": GOLOGIN_PORT})
    driver = None
    try:
        debugger = gl.start()
        time.sleep(2)
        driver = connect_chrome(debugger)
        driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT_S)

        homepage_html = _navigate(driver, url)
        if homepage_html is None:
            return False, "navigation failed on homepage", None, None, None

        homepage_png: bytes | None = None
        if want_screenshot:
            try:
                homepage_png = driver.get_screenshot_as_png()
            except Exception as exc:  # noqa: BLE001
                log.warning("homepage screenshot failed: %s", exc)

        stag_results = process_stag_in_browser(driver, lead_id, url)
        return True, None, homepage_html, homepage_png, stag_results
    except Exception as exc:  # noqa: BLE001
        return False, str(exc), None, None, None
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass
        try:
            gl.stop()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("enrichment worker started | port=%d poll=%ds", GOLOGIN_PORT, POLL_INTERVAL)
    while _running:
        try:
            job = claim_job()
            if job is None:
                time.sleep(POLL_INTERVAL)
                continue
            try:
                process_job(job)
            except Exception as exc:  # noqa: BLE001
                log.error("process_job error: %s", exc)
                try:
                    fail_job(job["id"], f"worker exception: {exc}")
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            log.error("loop error: %s", exc)
            time.sleep(POLL_INTERVAL)
    log.info("enrichment worker stopped cleanly")


if __name__ == "__main__":
    main()
