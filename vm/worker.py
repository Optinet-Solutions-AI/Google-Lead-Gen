#!/usr/bin/env python3
"""
Scrape queue worker. Runs forever under systemd on the AWS VM.

Responsibilities:
  - Poll Supabase claim_scrape_job() every POLL_INTERVAL_SECONDS.
  - For each claimed job, look up the GoLogin profile_id for the
    country, invoke gologin_start_profile_api_and_webscrape.py as
    a subprocess on this worker's port.
  - On SUCCESS: load the output JSON and call complete_scrape_job
    (atomic: batch_id + google_lead_gen_table rows + status + lock
    release all in one transaction).
  - On CAPTCHA: captcha_scrape_job, move on.
  - On any other failure: fail_scrape_job (requeues if attempts
    remain, else marks failed).

Designed to run multiple instances per VM — each on a different
GOLOGIN_PORT (9222, 9223, 9224) with a unique WORKER_ID. See the
systemd unit in this directory's README.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
WORKER_ID            = os.environ["WORKER_ID"]
GOLOGIN_PORT         = int(os.environ.get("GOLOGIN_PORT", "9222"))
POLL_INTERVAL        = int(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
SCRAPE_TIMEOUT_S     = int(os.environ.get("SCRAPE_TIMEOUT_SECONDS", "1200"))  # 20 min
# When interactive mode is on, the scraper may park at a wall and wait
# for an admin to resolve via noVNC. Bump the subprocess timeout to
# match the worst-case checkpoint TTL (default 15 min) plus the
# regular 20 min scrape budget. Set INTERACTIVE_MODE=off to disable.
INTERACTIVE_MODE          = os.environ.get("INTERACTIVE_MODE", "on").strip().lower() != "off"
INTERACTIVE_TIMEOUT_S     = int(os.environ.get("INTERACTIVE_SCRAPE_TIMEOUT_SECONDS", "2400"))  # 40 min
SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_KEY         = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SCRAPER_PATH         = os.environ.get(
    "SCRAPER_PATH",
    str(Path.home() / "scraper.py"),
)
KILL_SCRIPT_PATH     = os.environ.get(
    "KILL_SCRIPT_PATH",
    str(Path.home() / "kill_gologin.py"),
)
RESULTS_DIR          = os.environ.get("RESULTS_DIR", "/tmp")

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
    log.info("signal %d received — finishing current iteration then stopping", sig)
    _running = False


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


# ---------------------------------------------------------------------------
# Supabase RPC helpers
# ---------------------------------------------------------------------------

def claim_job() -> dict[str, Any] | None:
    """Atomically claim the next pending job for an unlocked country.

    PostgREST quirk: when an RPC declared `RETURNS public.scrape_queue`
    actually returns SQL NULL (no claimable row), PostgREST emits a
    JSON object with every column set to null — NOT a JSON null and
    not an empty array. The dict is truthy in Python, so a naive
    `if result.data:` check happily passes and the caller tries to
    process a "job" with id=None, country_code=None, etc.

    Treat any response without a populated `id` as "no job available".
    """
    result = supabase.rpc("claim_scrape_job", {"p_worker_id": WORKER_ID}).execute()
    data = result.data
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


def complete_job(job_id: str, results: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    supabase.rpc(
        "complete_scrape_job",
        {"p_job_id": job_id, "p_results": results, "p_summary": summary},
    ).execute()


def captcha_job(job_id: str) -> None:
    supabase.rpc("captcha_scrape_job", {"p_job_id": job_id}).execute()


def fail_job(job_id: str, error: str) -> None:
    supabase.rpc("fail_scrape_job", {"p_job_id": job_id, "p_error": error[:2000]}).execute()


SERP_SCREENSHOT_BUCKET = os.environ.get("SCREENSHOT_BUCKET", "lead-screenshots")


def _upload_serp_screenshots(job_id: str, results: list[dict[str, Any]]) -> None:
    """Best-effort upload of per-PPC SERP ad screenshots.

    The scraper drops PNGs at `/tmp/serp_ad_*.png` and tags each PPC
    result row with `local_serp_screenshot=<path>`. Here we upload
    each PNG to the lead-screenshots bucket under
    `serp/<job_id>/<idx>.png`, replace the local-path field with
    `serp_screenshot_path` (the bucket-relative path that the RPC
    expects), and delete the local file. Failures are logged but
    never block the rest of the job.
    """
    for idx, row in enumerate(results):
        local = row.pop("local_serp_screenshot", None)
        if not local or not os.path.exists(local):
            continue
        bucket_path = f"serp/{job_id}/{idx}_{int(time.time() * 1000)}.png"
        try:
            with open(local, "rb") as f:
                png = f.read()
            supabase.storage.from_(SERP_SCREENSHOT_BUCKET).upload(
                bucket_path,
                png,
                {"content-type": "image/png", "upsert": "true"},
            )
            row["serp_screenshot_path"] = bucket_path
            log.info("uploaded SERP ad screenshot for job=%s idx=%d → %s",
                     job_id, idx, bucket_path)
        except Exception as exc:  # noqa: BLE001
            log.warning("SERP screenshot upload failed for job=%s idx=%d: %s",
                        job_id, idx, exc)
        finally:
            try:
                os.unlink(local)
            except Exception:  # noqa: BLE001
                pass


def fetch_profile(country_code: str) -> dict[str, Any] | None:
    result = (
        supabase.table("gologin_profiles")
        .select("gologin_profile_id, country_name, requires_google_login")
        .eq("country_code", country_code)
        .single()
        .execute()
    )
    return result.data


# ---------------------------------------------------------------------------
# Scrape invocation
# ---------------------------------------------------------------------------

def _kill_port() -> None:
    """Best-effort kill of anything lingering on this worker's port."""
    try:
        subprocess.run(
            ["python3", KILL_SCRIPT_PATH, str(GOLOGIN_PORT)],
            capture_output=True,
            text=True,
            timeout=30,
            env=os.environ.copy(),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("kill_gologin failed (non-fatal): %s", exc)


def run_scrape(
    profile_id: str,
    keyword: str,
    country_name: str,
    pages: int,
    language: str = "en",
    engine: str = "google",
    job_id: str | None = None,
    country_code: str | None = None,
    requires_google_login: bool = False,
) -> tuple[int, str, Path, Path]:
    """
    Invoke the scraper as a subprocess.

    stdout + stderr are redirected to a combined file on disk so the
    OS pipe buffer (~64 KB) can never fill and deadlock the child.
    The scraper is noisy — Chromium / GoLogin / Sentry emit hundreds
    of KB of telemetry per run, which would block a capture_output
    subprocess within seconds.

    Returns: (exit_code, combined_log_text, json_output_path, log_path)
    """
    output_path = Path(RESULTS_DIR) / f"scrape_{WORKER_ID}_{GOLOGIN_PORT}.json"
    log_path    = Path(RESULTS_DIR) / f"scrape_{WORKER_ID}_{GOLOGIN_PORT}.log"
    output_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)

    cmd = [
        "python3",
        SCRAPER_PATH,
        profile_id,
        "-k", keyword,
        "-c", country_name,
        "--pages", str(pages),
        "--port", str(GOLOGIN_PORT),
        "--output", str(output_path),
        "--language", language,
        "--engine", engine,
    ]
    if country_code:
        cmd += ["--country-code", country_code]
    if requires_google_login:
        cmd += ["--requires-google-login"]
    if INTERACTIVE_MODE and job_id:
        # When interactive mode is on, hand the scraper enough context
        # to write interactive_checkpoints rows. Subprocess timeout
        # also bumps so paused jobs don't get TERM'd while a human is
        # clicking through.
        cmd += [
            "--interactive",
            "--job-id", job_id,
            "--worker-id", WORKER_ID,
        ]
    timeout_s = INTERACTIVE_TIMEOUT_S if (INTERACTIVE_MODE and job_id) else SCRAPE_TIMEOUT_S

    # DISPLAY is set per-port in the scrape-worker@<port>.service systemd
    # drop-in so each worker writes to its own Xvfb. Don't override here
    # or noVNC isolation breaks (everyone lands on :1).
    env = os.environ.copy()
    log.info("launching scraper (port=%d profile=%s log=%s timeout=%ds interactive=%s)",
             GOLOGIN_PORT, profile_id[:8], log_path, timeout_s,
             "yes" if (INTERACTIVE_MODE and job_id) else "no")

    with open(log_path, "w", encoding="utf-8") as log_f:
        result = subprocess.run(
            cmd,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            timeout=timeout_s,
        )

    # Read back only what we need to classify the outcome. Scraper logs
    # can be multi-MB, but the [RESULT] marker is always near the end.
    try:
        combined = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        combined = ""
    return result.returncode, combined, output_path, log_path


def process_job(job: dict[str, Any]) -> None:
    job_id = job["id"]
    country_code = job["country_code"]
    keyword = job["keyword"]
    pages = int(job.get("pages") or 1)
    # Accept missing `language` for backwards compatibility with old rows
    # that pre-date the migration that added the column.
    language = (job.get("language") or "en").strip().lower() or "en"
    engine = (job.get("search_engine") or "google").strip().lower() or "google"
    if engine not in ("google", "bing"):
        engine = "google"

    log.info("claimed job %s | country=%s keyword=%r pages=%d lang=%s engine=%s",
             job_id, country_code, keyword, pages, language, engine)

    # Look up the GoLogin profile ID for this country
    profile = fetch_profile(country_code)
    if not profile or not profile.get("gologin_profile_id"):
        fail_job(
            job_id,
            f"No gologin_profile_id configured for country_code={country_code}",
        )
        return
    profile_id = profile["gologin_profile_id"]
    country_name = profile.get("country_name") or country_code
    requires_google_login = bool(profile.get("requires_google_login"))

    # Defensive: make sure this port is free before we start
    _kill_port()

    try:
        exit_code, combined_log, output_path, log_path = run_scrape(
            profile_id, keyword, country_name, pages,
            language=language, engine=engine, job_id=job_id,
            country_code=country_code,
            requires_google_login=requires_google_login,
        )
    except subprocess.TimeoutExpired:
        _kill_port()
        timeout_used = INTERACTIVE_TIMEOUT_S if INTERACTIVE_MODE else SCRAPE_TIMEOUT_S
        fail_job(job_id, f"Scraper timed out after {timeout_used}s")
        return
    except Exception as exc:  # noqa: BLE001
        _kill_port()
        fail_job(job_id, f"Scraper invocation failed: {exc}")
        return

    # Classify the outcome by the [RESULT] marker the scraper prints.
    if "[RESULT] CAPTCHA" in combined_log:
        log.warning("job %s hit CAPTCHA (log=%s)", job_id, log_path)
        _kill_port()
        captcha_job(job_id)
        return

    if "[RESULT] SUCCESS" not in combined_log:
        _kill_port()
        tail = combined_log[-800:] if combined_log else "(empty log)"
        fail_job(job_id, f"Scraper exit={exit_code} — {tail}")
        return

    # Load the results JSON the scraper dropped for us
    if not output_path.exists():
        _kill_port()
        fail_job(job_id, f"Scraper reported SUCCESS but {output_path} is missing")
        return
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        _kill_port()
        fail_job(job_id, f"Bad output JSON: {exc}")
        return

    results = payload.get("results") or []
    summary = {
        "total_results": payload.get("total_results"),
        "organic_results": payload.get("organic_results"),
        "ppc_results": payload.get("ppc_results"),
        "pages_scraped": payload.get("pages_scraped"),
        "scraped_at": payload.get("timestamp"),
        # is_logged_in: True / False / None — flows into complete_scrape_job,
        # which bumps gologin_profiles.is_google_logged_in for the country.
        "is_logged_in": payload.get("is_logged_in"),
    }

    # Upload any per-PPC SERP screenshots the scraper saved to /tmp.
    # Replaces local_serp_screenshot (a /tmp path) with serp_screenshot_path
    # (a bucket-relative path) on each result row before the RPC fires.
    _upload_serp_screenshots(job_id, results)

    try:
        complete_job(job_id, results, summary)
    except Exception as exc:  # noqa: BLE001
        # Atomic RPC failed — job stays in 'running' with the lock held.
        # release_stale_locks() will eventually requeue it.
        log.error("complete_scrape_job RPC failed for %s: %s", job_id, exc)
        return

    _kill_port()
    log.info("job %s completed | %d results", job_id, len(results))


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("worker started | port=%d poll=%ds", GOLOGIN_PORT, POLL_INTERVAL)
    while _running:
        try:
            job = claim_job()
            if job is None:
                time.sleep(POLL_INTERVAL)
                continue
            process_job(job)
        except Exception as exc:  # noqa: BLE001
            log.error("loop error: %s", exc)
            time.sleep(POLL_INTERVAL)
    log.info("worker stopped cleanly")


if __name__ == "__main__":
    main()
