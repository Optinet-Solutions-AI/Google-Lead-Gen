#!/usr/bin/env python3
"""
[LGP-097] Playwright/Chromium-based S-tag render worker.

Purpose: fix the 26.5% FETCH_EMPTY bucket in the v2 audit — sites that
returned a near-empty body via plain-fetch because they're React/Next
SPAs. We visit each URL in a real Chromium session, wait for JS to
render, then persist the FULL post-JS HTML into fetched_html_cache so
the standard extraction pipeline can find the tag.

Reuses the existing scrape-worker + GoLogin infra: same country
profile, same proxy, same Chromium binary. Runs as its own systemd
unit so it can be scheduled independently of the primary scrapers.

Deploy (per VM):
  curl -o ~/stag_render_worker.py \
    https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main/vm/stag_render_worker.py
  # (systemd unit to be added in follow-up commit)

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOLOGIN_API_TOKEN,
  GOLOGIN_PORT, WORKER_ID  — same as scrape-worker@
  STAG_RENDER_BATCH_SIZE   — how many leads per Chromium session
                             (default 8; cap ~15 to avoid session-
                             fingerprint issues)
  STAG_RENDER_SETTLE_S     — post-load wait in seconds (default 3)
  STAG_RENDER_PAGE_TIMEOUT — hard page-load timeout (default 15s)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv()

WORKER_ID    = os.environ.get("WORKER_ID", "stag-render-vm?-?")
GOLOGIN_PORT = int(os.environ.get("GOLOGIN_PORT", "9222"))
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
GOLOGIN_API_TOKEN = os.environ["GOLOGIN_API_TOKEN"]

BATCH_SIZE       = int(os.environ.get("STAG_RENDER_BATCH_SIZE", "8"))
SETTLE_S         = int(os.environ.get("STAG_RENDER_SETTLE_S", "3"))
PAGE_TIMEOUT     = int(os.environ.get("STAG_RENDER_PAGE_TIMEOUT", "15"))
POLL_INTERVAL_S  = int(os.environ.get("POLL_INTERVAL_SECONDS", "30"))

SUPABASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)sZ [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(WORKER_ID)


# ---------------------------------------------------------------------------
# Work-list — leads with cached FETCH_EMPTY that we want to re-fetch with JS
# ---------------------------------------------------------------------------
CLAIM_RPC = "claim_stag_render_batch"


def claim_batch(country_code: str | None = None) -> list[dict[str, Any]]:
    """RPC returns a list of {lead_id, url, country_code} to re-render.
    Server-side: picks up to BATCH_SIZE leads whose fetched_html_cache
    row is empty (< 500 bytes) and hasn't been re-rendered yet. See
    supabase migration TBD.

    For rollout: if the RPC doesn't exist yet, fall back to plain
    Supabase-REST filter query."""
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/{CLAIM_RPC}",
        headers=SUPABASE_HEADERS,
        json={"p_worker_id": WORKER_ID, "p_batch_size": BATCH_SIZE, "p_country_code": country_code},
        timeout=30,
    )
    if resp.status_code == 404:
        return _fallback_claim(country_code)
    resp.raise_for_status()
    return resp.json() or []


def _fallback_claim(country_code: str | None) -> list[dict[str, Any]]:
    """Pre-RPC fallback: pull from fetched_html_cache directly. Used
    ONLY during initial rollout; once the RPC ships we drop this."""
    params = {
        "select": "lead_id,url,html",
        "html": "not.is.null",
        "order": "fetched_at.desc",
        "limit": BATCH_SIZE,
    }
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/fetched_html_cache",
        headers=SUPABASE_HEADERS,
        params=params,
        timeout=30,
    )
    resp.raise_for_status()
    all_rows = resp.json() or []
    # Filter to actually-empty ones client-side.
    empty = [r for r in all_rows if not r.get("html") or len(r["html"]) < 500]
    return [{"lead_id": r["lead_id"], "url": r["url"], "country_code": country_code} for r in empty]


def persist_html(lead_id: int, url: str, html: str, fetch_error: str | None = None) -> None:
    """Upsert the rendered HTML back into fetched_html_cache."""
    payload = {
        "lead_id": lead_id,
        "url": url,
        "html": html,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fetch_error": fetch_error,
        "source": "playwright_render",
    }
    headers = {**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"}
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/fetched_html_cache",
        headers=headers,
        json=payload,
        timeout=30,
    )
    if resp.status_code >= 300:
        log.warning("persist_html %s: %s %s", lead_id, resp.status_code, resp.text[:200])


# ---------------------------------------------------------------------------
# Chromium/GoLogin session
# ---------------------------------------------------------------------------
def open_chromium():
    """Boot Chromium via GoLogin. Returns (driver, gl_handle) so the
    caller can gl.stop() on shutdown."""
    from gologin import GoLogin
    from selenium import webdriver

    profile_id = os.environ.get("DEFAULT_STAG_RENDER_PROFILE_ID") or os.environ.get(
        "DEFAULT_STAG_POC_PROFILE_ID"
    )
    if not profile_id:
        log.error("No DEFAULT_STAG_RENDER_PROFILE_ID set — aborting.")
        sys.exit(2)

    gl = GoLogin(
        {
            "token": GOLOGIN_API_TOKEN,
            "profile_id": profile_id,
            "port": GOLOGIN_PORT,
        }
    )
    debugger_address = gl.start()
    log.info("GoLogin at %s (profile %s)", debugger_address, profile_id[:8])

    options = webdriver.ChromeOptions()
    options.add_experimental_option("debuggerAddress", debugger_address)
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(PAGE_TIMEOUT)
    return driver, gl


def render_url(driver, url: str) -> tuple[str | None, str | None]:
    """Load a URL in the browser, wait, return (html, error)."""
    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        return None, f"navigation_failed: {exc}"
    try:
        # Wait for at least <body> so we don't grab pre-JS placeholder.
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        WebDriverWait(driver, PAGE_TIMEOUT).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
    except Exception:  # noqa: BLE001
        pass
    time.sleep(SETTLE_S)
    try:
        html = driver.page_source
        return html, None
    except Exception as exc:  # noqa: BLE001
        return None, f"page_source_failed: {exc}"


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main() -> None:
    log.info("Booting stag_render_worker (batch=%d, settle=%ds)", BATCH_SIZE, SETTLE_S)
    driver, gl = open_chromium()
    try:
        while True:
            try:
                batch = claim_batch()
            except Exception as exc:  # noqa: BLE001
                log.error("claim_batch failed: %s — sleeping", exc)
                time.sleep(POLL_INTERVAL_S)
                continue

            if not batch:
                log.info("No work; sleeping %ds", POLL_INTERVAL_S)
                time.sleep(POLL_INTERVAL_S)
                continue

            log.info("Batch of %d URLs to render", len(batch))
            # Clear cookies so batch N doesn't carry state from N-1.
            try:
                driver.delete_all_cookies()
            except Exception:  # noqa: BLE001
                pass

            for row in batch:
                lead_id = row["lead_id"]
                url = row["url"]
                log.info("  render lead=%d url=%s", lead_id, url[:60])
                html, err = render_url(driver, url)
                if err or not html:
                    persist_html(lead_id, url, "", err or "empty_render")
                    continue
                persist_html(lead_id, url, html, None)
                log.info("  ok lead=%d html_len=%d", lead_id, len(html))

    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass
        try:
            gl.stop()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
