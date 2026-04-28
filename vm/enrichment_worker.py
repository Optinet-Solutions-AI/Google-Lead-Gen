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


def upload_screenshot(lead_id: int, png_bytes: bytes) -> str | None:
    path = f"lead_{lead_id}_{int(time.time())}.png"
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


def call_score_endpoint(lead_id: int, stage: str) -> None:
    try:
        r = requests.post(
            f"{APP_URL}/api/enrichment/score-row",
            json={"lead_id": lead_id, "stage": stage},
            headers={
                "Authorization": f"Bearer {INTERNAL_API_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=30,
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


def fetch_with_browser(profile_id: str, url: str, want_screenshot: bool
                       ) -> tuple[str | None, bytes | None, str | None]:
    """Open URL in the GoLogin profile, return (html, screenshot_bytes, error)."""
    gl = GoLogin({"token": GOLOGIN_TOKEN, "profile_id": profile_id, "port": GOLOGIN_PORT})
    driver = None
    try:
        debugger = gl.start()
        time.sleep(2)
        driver = connect_chrome(debugger)
        driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT_S)
        try:
            driver.get(url)
        except Exception as exc:  # noqa: BLE001
            return None, None, f"navigation: {exc}"
        # Let JS-rendered content settle
        try:
            WebDriverWait(driver, PAGE_LOAD_TIMEOUT_S).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
        except Exception:  # noqa: BLE001
            pass
        time.sleep(PAGE_SETTLE_S)
        html = driver.page_source
        screenshot_bytes: bytes | None = None
        if want_screenshot:
            try:
                screenshot_bytes = driver.get_screenshot_as_png()
            except Exception as exc:  # noqa: BLE001
                log.warning("screenshot capture failed: %s", exc)
        return html, screenshot_bytes, None
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

    html, png, err = fetch_with_browser(
        profile["gologin_profile_id"], url, want_screenshot,
    )

    screenshot_path: str | None = None
    if png is not None:
        screenshot_path = upload_screenshot(lead_id, png)

    complete_job(
        job_id,
        html if want_html else None,
        screenshot_path,
        err,
    )

    # Inline scoring per requested stage. Only attempt if we got HTML; the
    # API endpoint handles the fetch_error case anyway, so call it either
    # way to record ERROR confidence per stage.
    for stage in process_stages:
        if not isinstance(stage, str) or not stage:
            continue
        call_score_endpoint(lead_id, stage)

    log.info("enrichment job %s done | err=%s screenshot=%s", job_id, err, screenshot_path)


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
