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

import base64
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


# ---------------------------------------------------------------------------
# Workaround for gologin 2026.02.03 bug at gologin.py:762 — int('') ValueError
# when a profile's navigator.userAgent lacks a "Chrome/X.Y" token. This was
# the cause of 90% of enrichment failures in the 7d window before this patch.
# Pre-seed executablePath + orbita_major_version so spawnBrowser() skips the
# broken version-derivation branch entirely.
# ---------------------------------------------------------------------------
def _find_latest_orbita() -> tuple[str, int]:
    base = os.path.expanduser("~/.gologin/browser")
    try:
        candidates: list[tuple[int, str]] = []
        for name in os.listdir(base):
            if not name.startswith("orbita-browser-"):
                continue
            tail = name.rsplit("-", 1)[-1]
            if not tail.isdigit():
                continue
            path = os.path.join(base, name, "chrome")
            if os.path.isfile(path) and os.access(path, os.X_OK):
                candidates.append((int(tail), path))
        if candidates:
            candidates.sort(reverse=True)
            return candidates[0][1], candidates[0][0]
    except OSError:
        pass
    return "/usr/bin/google-chrome", 0


_ORBITA_FALLBACK_PATH, _ORBITA_FALLBACK_MAJOR = _find_latest_orbita()
log.info("orbita fallback resolved: path=%s major=%d", _ORBITA_FALLBACK_PATH, _ORBITA_FALLBACK_MAJOR)


def _install_gologin_spawn_patch() -> None:
    import gologin.gologin as _gologin_mod
    _orig_spawn = _gologin_mod.GoLogin.spawnBrowser

    def _safe_spawn(self):
        if not getattr(self, "executablePath", ""):
            profile = getattr(self, "profile", None) or {}
            ua = (profile.get("navigator") or {}).get("userAgent") or ""
            chrome_part = ua.split("Chrome/")[1].split(" ")[0] if "Chrome/" in ua else ""
            major_str = chrome_part.split(".")[0] if chrome_part else ""
            if not major_str.isdigit():
                log.warning(
                    "gologin: profile UA missing Chrome/X.Y — using local Orbita %d at %s",
                    _ORBITA_FALLBACK_MAJOR, _ORBITA_FALLBACK_PATH,
                )
                self.executablePath = _ORBITA_FALLBACK_PATH
                self.orbita_major_version = _ORBITA_FALLBACK_MAJOR
                self.chromium_version = f"{_ORBITA_FALLBACK_MAJOR}.0.0.0"
        return _orig_spawn(self)

    _gologin_mod.GoLogin.spawnBrowser = _safe_spawn


_install_gologin_spawn_patch()


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
    """Atomically claim the next pending enrichment fetch.

    PostgREST returns a JSON object with all-null columns when an
    RPC declared `RETURNS public.enrichment_fetch_queue` actually
    returns SQL NULL — the dict is truthy in Python so a naive
    truthy-check would treat "no job available" as a real claim.
    Reject any response without a populated `id`.
    """
    res = supabase.rpc(
        "claim_enrichment_fetch_job", {"p_worker_id": WORKER_ID}
    ).execute()
    data = res.data
    if not data:
        return None
    if isinstance(data, list):
        if len(data) == 0:
            return None
        first = data[0]
        if not isinstance(first, dict) or first.get("id") is None:
            return None
        return first
    if isinstance(data, dict):
        if data.get("id") is None:
            return None
        return data
    return None


def _rpc_retry(label: str, job_id: str, fn, *, swallow: bool) -> None:
    """Run a job-terminating RPC with a short retry.

    complete/fail_enrichment_fetch_job release the country lock (DELETE
    active_profile_locks) inside the SQL. If a transient DB/network blip lets
    the exception escape, the job is left stuck 'running' with its lock held
    until release_stale_locks (~30 min), stalling that country's enrichment
    queue. Retry the common transient case, then:
      - swallow=False (complete_job): re-raise so main()'s fallback marks the
        job failed (better than silently leaving it running).
      - swallow=True (fail_job): this IS the fallback — log and swallow so the
        loop keeps serving other jobs; stale-lock sweep is the final backstop."""
    last_exc: Exception | None = None
    for attempt in range(1, 4):
        try:
            fn()
            return
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            log.error("%s RPC failed for job %s (attempt %d/3): %s", label, job_id, attempt, exc)
            if attempt < 3:
                time.sleep(2 * attempt)
    if swallow:
        log.error(
            "%s RPC permanently failed for job %s — lock (if any) will clear via release_stale_locks",
            label, job_id,
        )
        return
    raise last_exc if last_exc else RuntimeError(f"{label} permanently failed")


def complete_job(job_id: str, html: str | None, screenshot_path: str | None,
                 fetch_error: str | None) -> None:
    _rpc_retry(
        "complete_enrichment_fetch_job", job_id,
        lambda: supabase.rpc(
            "complete_enrichment_fetch_job",
            {
                "p_job_id": job_id,
                "p_html": html,
                "p_screenshot_path": screenshot_path,
                "p_fetch_error": fetch_error,
            },
        ).execute(),
        swallow=False,
    )


def fail_job(job_id: str, error: str) -> None:
    msg = error[:2000]
    _rpc_retry(
        "fail_enrichment_fetch_job", job_id,
        lambda: supabase.rpc("fail_enrichment_fetch_job", {"p_job_id": job_id, "p_error": msg}).execute(),
        swallow=True,
    )


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


def _is_cancel_requested(job_id: str | None) -> bool:
    """Cheap polling check: did the dashboard ask us to abort this job?
    Called between heavy iterations (each tracking-link redirect).
    Best-effort — DB hiccups should never block the worker, so failures
    fall through to False and the loop continues."""
    if not job_id:
        return False
    try:
        r = (
            supabase.table("enrichment_fetch_queue")
            .select("cancel_requested")
            .eq("id", job_id)
            .single()
            .execute()
        )
        return bool(r.data and r.data.get("cancel_requested"))
    except Exception as exc:  # noqa: BLE001
        log.warning("cancel-check failed for %s: %s", job_id, exc)
        return False


# Recent iPhone Safari UA — kept close to the CDP helper so it's easy
# to bump when Apple rolls Safari forward and casino-affiliate sites
# start UA-sniffing for newer versions.
_MOBILE_IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.4 Mobile/15E148 Safari/604.1"
)


def _set_mobile_viewport(driver: webdriver.Chrome) -> bool:
    """Switch the running tab to iPhone UA + 375x812 viewport via CDP.
    The override sticks for the rest of the driver session; we're inside
    a per-job GoLogin profile that gets torn down after each lead, so
    leaking into another lead can't happen. Returns True on success."""
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
        log.warning("mobile viewport CDP override failed: %s", exc)
        return False


def _load_rooster_partner_brands() -> set[str]:
    """Load the current active Rooster partner brand list once per job.

    Returns a lowercase set of brand domains (e.g. {"betway", "casumo"}).
    The stag stage uses this to short-circuit tag extraction on brands
    we already partner with — per the 2026-07-24 spec, we still record
    the brand row for reference, but don't spend redirect+cookie
    resolution time on it.

    Failure returns an empty set — worst case is we do the extra work,
    never dropping the row entirely.
    """
    try:
        res = (
            supabase.table("rooster_brands")
            .select("domain")
            .eq("is_active", True)
            .execute()
        )
        rows = res.data or []
        return {
            (row.get("domain") or "").strip().lower()
            for row in rows
            if row.get("domain")
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("rooster brand pre-load failed: %s", exc)
        return set()


def _crawl_for_tracking_links(
    driver: webdriver.Chrome,
    url: str,
    lead_id: int,
    label: str,
) -> list[str]:
    """Load homepage + up to MAX_EXTRA_PAGES casino-listing pages, return
    the deduped list of tracking-link URLs in page-visit order (homepage
    first, then each listing page in the order they were discovered).
    Order matters because callers cap how many links they actually
    resolve — homepage CTAs are the highest-value links and need to be
    kept under any cap."""
    home_html = _navigate(driver, url)
    if not home_html:
        return []

    pages_html: list[tuple[str, str]] = [(url, home_html)]
    for extra_url in _pick_stag_pages(home_html, url):
        chunk = _navigate(driver, extra_url, settle_s=2)
        if chunk:
            pages_html.append((extra_url, chunk))

    ordered: list[str] = []
    seen: set[str] = set()
    for page_url, page_html in pages_html:
        for link in extract_tracking_links(page_html, page_url):
            if link in seen:
                continue
            seen.add(link)
            ordered.append(link)

    log.info(
        "stag: lead=%s pass=%s found %d tracking links across %d pages",
        lead_id, label, len(ordered), len(pages_html),
    )
    return ordered


def process_stag_in_browser(
    driver: webdriver.Chrome,
    lead_id: int,
    url: str,
    job_id: str | None = None,
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

    Conditional mobile-pass retry: when the desktop crawl returns zero
    tracking links, switch the tab to iPhone UA + 375x812 viewport via
    CDP and re-crawl. Many casino-affiliate sites only render their
    tracking-link stack under a mobile UA / pointer:coarse media query;
    this catches those without paying the cost of a second pass on
    pages that already returned links on desktop.

    Heavy on browser navigations — count one per tracking link plus N+1
    page loads. Relies on the country lock to stay single-occupant.
    """
    # Rooster-partner pre-check: load once so the per-brand skip in the
    # resolve loop below is O(1). Empty set on failure — falls through
    # to normal extraction, so a transient DB blip never drops rows.
    rooster_partner_brands = _load_rooster_partner_brands()

    # Desktop pass.
    seen_tracking = _crawl_for_tracking_links(driver, url, lead_id, label="desktop")
    extracted_via = "desktop"

    # Mobile retry only when desktop yielded nothing.
    if not seen_tracking:
        log.info(
            "stag: lead=%s desktop pass returned zero tracking links — retrying via mobile viewport",
            lead_id,
        )
        if _set_mobile_viewport(driver):
            seen_tracking = _crawl_for_tracking_links(driver, url, lead_id, label="mobile")
            extracted_via = "mobile"

    if not seen_tracking:
        log.info("stag: lead=%s no tracking links found in either pass", lead_id)
        return []

    # No dedupe by tag value — if the affiliate page exposes 10
    # outbound tracking links, we want 10 s_tag rows, even if some
    # links collapse to the same short ID after truncation. This
    # matches the operator's "10 links = 10 s-tags" expectation, so
    # we cap at 10. Each link costs ~15-20s of browser
    # navigation + redirect resolve + screenshot upload, so a cap
    # of 30 (the previous value) blew per-lead runtime out to ~10
    # minutes once the same-host fix started surfacing the full
    # cloaked-link inventory — that's the "keep trying for so long"
    # operator complaint. 10 keeps the worst case ~3 min while still
    # covering every affiliate-review top-list we've seen.
    resolved: list[dict] = []
    tracking_list = seen_tracking[:10]
    for i, tracking_url in enumerate(tracking_list):
        # Cooperative cancellation: dashboard cancel sets cancel_requested=true
        # on this row; we bail out between redirects so partial results stick.
        if _is_cancel_requested(job_id):
            log.info(
                "stag: lead=%s job=%s cancellation requested — stopping after %d/%d links",
                lead_id, job_id, i, len(tracking_list),
            )
            break
        final_url, chain, screenshot, cookies = resolve_in_browser(driver, tracking_url)
        if not final_url:
            continue
        brand = guess_brand_from_url(final_url)

        # Monday / Rooster-partner pre-check: brand already registered
        # as a Rooster partner? Skip the tag extraction work and just
        # record the brand row for reference. Per operator's 2026-07-24
        # spec: "we dont need to get the stags of links or websites
        # that's already in the monday data". Downstream rows still
        # flow through the RPC's is_rooster_brand flag so the UI can
        # highlight them as "already partnered — skipped".
        tag_value: str | None = None
        source_param: str | None = None
        extracted_via_row = extracted_via
        brand_key = (brand or "").strip().lower()
        if brand_key and brand_key in rooster_partner_brands:
            extracted_via_row = f"{extracted_via}_skipped_partner"
        else:
            # Tag extraction: URL params first (cheap), cookies second.
            # Cookies added 2026-07-24 to catch networks that drop the
            # affiliate ID as a cookie mid-redirect and land the browser
            # on a param-less operator URL.
            parsed_url = parse_stag_from_url(final_url)
            if parsed_url:
                tag_value, source_param = parsed_url
            else:
                parsed_cookie = parse_stag_from_cookies(cookies)
                if parsed_cookie:
                    tag_value, source_param = parsed_cookie
                    extracted_via_row = f"{extracted_via}_cookie"

        screenshot_path: str | None = None
        if screenshot:
            screenshot_path = upload_screenshot(
                lead_id, screenshot, suffix=f"stag_{i}_{int(time.time() * 1000)}",
            )

        # Always record ONE row per outbound brand link, even when
        # neither URL params nor cookies gave us the tag. Downstream
        # (10-rows-per-lead invariant): the operator gets to see the
        # affiliate promotes this brand even when the tag itself is
        # cloaked. Empty s_tag is a signal, not a failure.
        resolved.append({
            "s_tag": tag_value or "",
            "source_param": source_param,
            "brand": brand,
            "tracking_url": tracking_url,
            "final_url": final_url,
            "redirect_chain": chain,
            "screenshot_path": screenshot_path,
            "extracted_via": extracted_via_row,
        })

    return resolved


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

# --- 2026-07-24: widened extractor + cookie support ------------------
# Legacy STAG_PARAM_ORDER above kept for backwards compatibility on the
# rare paths that still walk it directly. New code paths use the
# NETWORKS registry below which covers 13 known affiliate networks
# instead of the original 5-param set. Mirrors lib/stag-extraction/
# networks.ts on the TS side.
NETWORKS: tuple[dict, ...] = (
    dict(key="cellxpert",          url_params=("cxd", "clickid"),
         cookies=("cxd", "cxd_offer_id", "cxd_click_id", "cellxpert_click", "affid")),
    dict(key="income_access",      url_params=("iaid", "aff", "sub_aff", "ia_partner"),
         cookies=("ias_partner", "ias_part", "iaid", "iaclickid")),
    dict(key="myaffiliates",       url_params=("btag", "bta", "affiliate_id"),
         cookies=("ma_click_id", "ma_visit", "bta", "btag_cookie")),
    dict(key="netrefer",           url_params=("btag", "nrid", "affid"),
         cookies=("nrclickid", "nr_pid", "nr_bta")),
    dict(key="post_affiliate_pro", url_params=("a_aid", "affiliateid", "a_bid"),
         cookies=("papvisitorid", "papcookie_visit", "a_aid")),
    dict(key="hasoffers",          url_params=("offer_id", "aff_id", "transaction_id", "aff_sub"),
         cookies=("aff_sub_id", "hasoffers_aff", "transaction_id")),
    dict(key="everflow",           url_params=("ef_id", "offer_id", "transaction_id", "oid"),
         cookies=("ef_click", "_ef_click", "ef_transaction_id")),
    dict(key="impact",             url_params=("irclickid", "clickid", "sharedid"),
         cookies=("iradmc", "_impact_id", "ir_click_id")),
    dict(key="commissionjunction", url_params=("pid", "aid", "sid"),
         cookies=("cje", "cj_user", "cjevent")),
    dict(key="rakuten",            url_params=("ranmid", "raneaid", "ransiteid"),
         cookies=("ranmid", "r_ranpid", "ransiteid")),
    dict(key="kwanko",             url_params=("ns_source", "ns_campaign", "noc_aff"),
         cookies=("kwanko_click", "ktag")),
    dict(key="admitad",            url_params=("admitad_uid", "ad_id"),
         cookies=("aduid", "_asc")),
    dict(key="generic",            url_params=("stag", "affid", "mid", "aff", "ref", "affiliate_id"),
         cookies=("stag", "affid", "aff_id", "affiliate_id")),
)


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
        base_host = re.sub(r"^www\.", "", urlparse(base_url).netloc.lower())
    except Exception:  # noqa: BLE001
        base_host = ""

    found: set[str] = set()

    def _consider(raw: str) -> None:
        if not _is_tracking_link(raw):
            return
        try:
            absolute = urljoin(base_url, raw)
            host = re.sub(r"^www\.", "", urlparse(absolute).netloc.lower())
        except Exception:  # noqa: BLE001
            return
        # Same-host links are kept on purpose: affiliate sites routinely
        # cloak outbound links behind their own domain
        # (e.g. footitalia.com/visit/goldenpanda/, betkiwi.co.nz/visit/X/casino/)
        # which 302s to the real affiliate URL. The earlier same-host
        # filter dropped all of these and was the dominant reason S-tag
        # found zero links on most leads. _is_tracking_link() already
        # filtered the URL shape, so false positives are just wasted
        # navigations downstream, not bad DB rows.
        if not host or host in EXCLUDED_HOSTS:
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
    """Return (tag_value, source_param) for the FIRST matching key, in priority order.

    Truncates the value at the first underscore so values like
    "54354_53463gdfbdy3534gdfv4" collapse to just "54354" — that's the
    short ID the affiliate-management workflow keys off; the suffix
    after the underscore is per-click tracking noise.
    """
    try:
        qs = parse_qs(urlparse(url).query, keep_blank_values=False)
    except Exception:  # noqa: BLE001
        return None
    # parse_qs is case-sensitive on keys; build a case-insensitive view.
    lower_qs = {k.lower(): v for k, v in qs.items()}
    # Legacy 5-param check first so anything the historical pipeline
    # accepted still resolves to the same source_param label.
    for key in STAG_PARAM_ORDER:
        v = lower_qs.get(key)
        if v and v[0]:
            short = v[0].split("_", 1)[0]
            if not short:
                continue
            return short, key
    # Widened check via NETWORKS. Walk every network's URL params in
    # registry order; first hit wins.
    for network in NETWORKS:
        for key in network["url_params"]:
            v = lower_qs.get(key.lower())
            if v and v[0]:
                short = v[0].split("_", 1)[0]
                if not short:
                    continue
                return short, key
    return None


def parse_stag_from_cookies(cookies: list[dict]) -> tuple[str, str] | None:
    """Given driver.get_cookies() output, walk each cookie and check if
    its name matches a known affiliate-tracking cookie from NETWORKS.
    Returns (tag_value, cookie_name) for the first match, None
    otherwise. Uses the same 'split on first underscore' shortening
    the URL-param path uses so DB values stay comparable.
    """
    if not cookies:
        return None
    by_name = {}
    for c in cookies:
        name = (c.get("name") or "").lower()
        val = (c.get("value") or "").strip()
        if not name or not val:
            continue
        by_name[name] = val
    for network in NETWORKS:
        for name in network["cookies"]:
            v = by_name.get(name.lower())
            if not v:
                continue
            short = v.split("_", 1)[0]
            if not short:
                continue
            return short, name
    return None


def guess_brand_from_url(url: str) -> str | None:
    try:
        host = re.sub(r"^www\.", "", urlparse(url).netloc.lower())
        parts = host.split(".")
        if len(parts) < 2:
            return None
        return ".".join(parts[:-1]) or None
    except Exception:  # noqa: BLE001
        return None


_WAKE_DEFERRED_JS = """
// Wake up WP Rocket / LiteSpeed Cache / WP Fastest Cache / Autoptimize
// style "delay JavaScript execution until user interaction" gates.
// Each of these optimizers hangs the *actual* content-loading scripts
// off one of these event listeners so the initial page paints without
// them. Without a real user event they never fire, and the affiliate
// list / lazy widgets stay empty.
try {
  var events = ['mousemove','mousedown','mouseover','touchstart','touchmove','wheel','keydown','scroll','click'];
  events.forEach(function(name){
    try { document.dispatchEvent(new Event(name, {bubbles: true})); } catch(_) {}
    try { window.dispatchEvent(new Event(name, {bubbles: true})); } catch(_) {}
    try { document.body && document.body.dispatchEvent(new Event(name, {bubbles: true})); } catch(_) {}
  });
  // Nudge scroll — some optimizers gate on the scroll delta specifically.
  try { window.scrollTo(0, 200); } catch(_) {}
} catch(_) {}
"""


def _navigate(driver: webdriver.Chrome, url: str, settle_s: int = PAGE_SETTLE_S) -> str | None:
    """Navigate + return page_source, or None on failure.

    Two-stage capture: after the initial settle we fire synthetic user
    events (mousemove/scroll/keydown/touchstart/click) to trip WP Rocket
    and its cousins' "delay JavaScript until user interaction" gates,
    then wait a beat for the deferred scripts to fetch + inject content
    into the DOM. Doubles our HTML yield on delay-JS review sites (which
    is most of the German casino affiliate corpus).
    """
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
    # Wake deferred JS then give it up to 3s to actually inject content.
    # Failure is silent — we still fall through and capture whatever's
    # in the DOM at that point.
    try:
        driver.execute_script(_WAKE_DEFERRED_JS)
        time.sleep(3)
    except Exception:  # noqa: BLE001
        pass
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


def _full_page_screenshot(driver: webdriver.Chrome) -> bytes | None:
    """Capture the whole page top-to-bottom as PNG bytes.

    Selenium's get_screenshot_as_png() only grabs the visible viewport, so
    landing-page captures came out as just the hero section — and the
    enrichment re-capture then overwrote the good full-page screenshot the
    scraper takes at scrape time. Mirror that proven scrape-time approach
    (scraper.py): scroll through to trigger lazy-loaded content, snap back
    to the top, then use CDP Page.captureScreenshot with
    captureBeyondViewport to render the full scroll height in one PNG.
    Falls back to the viewport screenshot if CDP is unavailable.
    """
    try:
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
        cdp = driver.execute_cdp_cmd(
            "Page.captureScreenshot",
            {"captureBeyondViewport": True, "fromSurface": True},
        )
        return base64.b64decode(cdp["data"])
    except Exception as exc:  # noqa: BLE001
        log.warning("full-page screenshot failed (%s) — falling back to viewport", exc)
        try:
            return driver.get_screenshot_as_png()
        except Exception:  # noqa: BLE001
            return None


def resolve_in_browser(driver: webdriver.Chrome, tracking_url: str
                       ) -> tuple[str | None, list[str], bytes | None, list[dict]]:
    """
    Open a tracking URL in the GoLogin browser, follow all redirects,
    return (final_url, chain_steps, screenshot_bytes, cookies).
    Same country profile = correct geo-routed redirect.

    Cookies added 2026-07-24: some affiliate networks (Cellxpert /
    MyAffiliates / Post Affiliate Pro) drop the tag as a cookie
    during the redirect chain — the URL ends up on the operator's
    own domain with no query params, so cookie extraction is the
    ONLY path to get the tag. Wipe the jar before nav so we only
    capture cookies from THIS click's chain.
    """
    chain = [tracking_url]
    try:
        driver.delete_all_cookies()
    except Exception:  # noqa: BLE001
        pass
    try:
        driver.set_page_load_timeout(20)
    except Exception:  # noqa: BLE001
        pass
    try:
        driver.get(tracking_url)
    except Exception as exc:  # noqa: BLE001
        log.debug("redirect-resolve nav failed: %s", exc)
        return None, chain, None, []
    time.sleep(2)
    try:
        final_url = driver.current_url
    except Exception:  # noqa: BLE001
        return None, chain, None, []
    if final_url and final_url != tracking_url:
        chain.append(final_url)
    # Best-effort cookie capture — post-redirect the browser holds
    # everything the affiliate handshake dropped.
    cookies: list[dict] = []
    try:
        cookies = driver.get_cookies() or []
    except Exception:  # noqa: BLE001
        pass
    # Best-effort screenshot for audit trail
    screenshot: bytes | None = None
    try:
        screenshot = driver.get_screenshot_as_png()
    except Exception:  # noqa: BLE001
        pass
    return final_url, chain, screenshot, cookies


def fetch_with_browser(
    profile_id: str,
    url: str,
    want_screenshot: bool,
    multi_page: bool = False,
    job_id: str | None = None,
) -> tuple[str | None, bytes | None, str | None]:
    """Open URL in the GoLogin profile, return (html, screenshot_bytes, error).

    If multi_page=True, also navigates to up to MAX_EXTRA_PAGES contact-shaped
    links on the homepage and concatenates their HTML into one blob (with
    page-break markers) so the score-row endpoint can extract from all of them.

    job_id is forwarded to _open_and_fetch so it can check for cooperative
    cancellation between contact-page navigations on long multi_page runs.
    """
    return _open_and_fetch(profile_id, url, want_screenshot, multi_page, job_id=job_id)


def _ensure_profile_idle(gl: "GoLogin") -> None:
    """
    Belt-and-braces cleanup before opening a profile.

    Stops any active session for the profile — covers all of:
      - this worker's previous run that didn't tear down cleanly
      - an orphan from a crashed run on this VM
      - a session opened from the user's GoLogin desktop app
      - a session left running on another VM that points at the
        same profile

    `gl.stop()` is idempotent: if nothing is running it's a no-op.
    The brief sleep gives GoLogin's cloud sync time to flush cookies
    back to the profile bundle BEFORE we open a fresh session — this
    is what prevents Google from signing out when the worker opens on
    top of an in-flight session that hadn't synced its cookies yet.
    """
    try:
        gl.stop()
        log.debug("pre-start gl.stop() ok")
    except Exception as exc:  # noqa: BLE001
        log.debug("pre-start gl.stop() (expected if idle): %s", exc)
    time.sleep(3)


def _open_and_fetch(
    profile_id: str,
    url: str,
    want_screenshot: bool,
    multi_page: bool,
    job_id: str | None = None,
) -> tuple[str | None, bytes | None, str | None]:
    gl = GoLogin({"token": GOLOGIN_TOKEN, "profile_id": profile_id, "port": GOLOGIN_PORT})
    driver = None
    try:
        _ensure_profile_idle(gl)
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
                screenshot_bytes = _full_page_screenshot(driver)
            except Exception as exc:  # noqa: BLE001
                log.warning("screenshot capture failed: %s", exc)

        if not multi_page:
            return homepage, screenshot_bytes, None

        chunks = [f"<!-- PAGE: {url} -->", homepage]
        for extra in _pick_contact_pages(homepage, url):
            # Cooperative cancellation between contact-page nav steps —
            # contact extraction can visit multiple pages per lead.
            if _is_cancel_requested(job_id):
                log.info(
                    "contact: job=%s cancellation requested — stopping multi-page crawl",
                    job_id,
                )
                break
            extra_html = _navigate(driver, extra, settle_s=2)
            if extra_html:
                chunks.append(f"<!-- PAGE: {extra} -->")
                chunks.append(extra_html)

        return "\n".join(chunks), screenshot_bytes, None
    except Exception as exc:  # noqa: BLE001
        log.exception("fetch_with_browser failed for %s", url)
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

    # Defensive: if the dashboard cancelled this row between claim and
    # the start of work, short-circuit before launching Chromium. The
    # main cancellation point lives inside the s-tag loop, which is
    # where the long tail actually lives — but if cancel arrived during
    # the brief claim window, no point spinning up the browser.
    if _is_cancel_requested(job_id):
        log.info("enrichment job %s cancelled before processing — skipping", job_id)
        complete_job(job_id, None, None, "cancelled by operator")
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
            job_id=job_id,
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
        job_id=job_id,
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
        _ensure_profile_idle(gl)
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
            final_url, _chain, _screenshot, _cookies = resolve_in_browser(driver, tracking_url)
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
    job_id: str | None = None,
) -> tuple[bool, str | None, str | None, bytes | None, list[dict] | None]:
    """
    One Chromium session covering both the homepage HTML cache write
    AND the s-tag multi-page extract + redirect resolve flow.

    Returns (ok, error, html_for_cache, homepage_png, resolved_stags).
    """
    gl = GoLogin({"token": GOLOGIN_TOKEN, "profile_id": profile_id, "port": GOLOGIN_PORT})
    driver = None
    try:
        _ensure_profile_idle(gl)
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
                homepage_png = _full_page_screenshot(driver)
            except Exception as exc:  # noqa: BLE001
                log.warning("homepage screenshot failed: %s", exc)

        stag_results = process_stag_in_browser(driver, lead_id, url, job_id=job_id)
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
                log.error("process_job error for job %s: %s", job.get("id"), exc)
                # fail_job is self-protecting (retries + logs its own failures),
                # so we no longer swallow its errors silently here.
                fail_job(job["id"], f"worker exception: {exc}")
        except Exception as exc:  # noqa: BLE001
            log.error("loop error: %s", exc)
            time.sleep(POLL_INTERVAL)
    log.info("enrichment worker stopped cleanly")


if __name__ == "__main__":
    main()
