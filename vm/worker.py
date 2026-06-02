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
import re
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
# for an admin to resolve via noVNC. With the refresh-loop wrapper in
# scraper.py (CHECKPOINT_MAX_REFRESH_ATTEMPTS=10, captcha_solver_ttl_minutes=5),
# the worst case is 10 cycles x 5 min = 50 min of Captcha solver waiting
# plus the regular 20 min scrape budget = 70 min. 65 min gives a small
# under-cap so a truly stuck captcha doesn't hold a worker hostage for
# 70+ min. Set CAPTCHA_SOLVER_MODE=off to disable.
CAPTCHA_SOLVER_MODE       = os.environ.get("CAPTCHA_SOLVER_MODE", "on").strip().lower() != "off"
INTERACTIVE_TIMEOUT_S     = int(os.environ.get("INTERACTIVE_SCRAPE_TIMEOUT_SECONDS", "3900"))  # 65 min


def _captcha_solver_enabled_per_db() -> bool:
    """Read the runtime captcha_solver_enabled flag from public.system_settings
    via the get_system_setting RPC. Cached short-term per process; refreshed
    on each process_job() invocation by the wrapper below."""
    try:
        result = supabase.rpc(
            "get_system_setting", {"p_key": "captcha_solver_enabled"}
        ).execute()
        val = result.data
        # RPC returns jsonb. Supabase-py decodes to Python bool/dict/etc.
        # Anything other than `false` (case-insensitive) is treated as on.
        if val is False:
            return False
        if isinstance(val, str) and val.strip().lower() == "false":
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        # Settings table missing or DB unreachable — keep current behaviour
        # (env-var default) instead of hard-failing the worker.
        log.warning("captcha_solver_enabled lookup failed (%s) — falling back to env default", exc)
        return CAPTCHA_SOLVER_MODE


def captcha_solver_should_run() -> bool:
    """The two gates the worker honours, joined with AND:
      - CAPTCHA_SOLVER_MODE env var (per-worker kill switch on the VM)
      - system_settings.captcha_solver_enabled (admin toggle via /admin/system)
    Both must be true for the Captcha solver to actually fire. Env-var
    off = absolute block regardless of DB; DB off = global block until
    an admin flips it back on."""
    if not CAPTCHA_SOLVER_MODE:
        return False
    return _captcha_solver_enabled_per_db()
# MOBILE_PASS_ENABLED — controls whether scraper.py runs its mobile PPC
# pass after the desktop SERP loop. Default on; set to 'off' on a
# country/worker where captcha pain is high enough that the extra SERP
# request outweighs the extra mobile-only ad coverage.
MOBILE_PASS_ENABLED       = os.environ.get("MOBILE_PASS_ENABLED", "on").strip().lower() != "off"
SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_KEY         = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SCRAPER_PATH         = os.environ.get(
    "SCRAPER_PATH",
    str(Path.home() / "scraper.py"),
)
YOUTUBE_SEARCH_PATH  = os.environ.get(
    "YOUTUBE_SEARCH_PATH",
    str(Path.home() / "youtube_search.py"),
)
# YouTube search is an HTTP call — no GoLogin/Selenium — so it finishes
# in seconds. Cap at 5 min so a hung connection fails fast instead of
# holding the worker for the full 20-min scrape budget.
YOUTUBE_SEARCH_TIMEOUT_S = int(os.environ.get("YOUTUBE_SEARCH_TIMEOUT_SECONDS", "300"))
# YouTube Phase 2 (contact enrichment) is the browser path: a real GoLogin
# session opening up to YOUTUBE_PHASE2_TOP_N channel About tabs to scrape
# socials + the reCAPTCHA-gated email. Budget like a full scrape, not the
# pure-HTTP Phase 1.
YOUTUBE_PROFILE_SCRAPE_PATH = os.environ.get(
    "YOUTUBE_PROFILE_SCRAPE_PATH",
    str(Path.home() / "youtube_profile_scrape.py"),
)
YOUTUBE_PHASE2_TOP_N = int(os.environ.get("YOUTUBE_PHASE2_TOP_N", "25"))
KICK_SEARCH_PATH     = os.environ.get(
    "KICK_SEARCH_PATH",
    str(Path.home() / "kick_search.py"),
)
# Kick search is also pure HTTP (App Access Token + 3 API endpoints).
# Same 5-min cap as YouTube — typical run is a few seconds.
KICK_SEARCH_TIMEOUT_S = int(os.environ.get("KICK_SEARCH_TIMEOUT_SECONDS", "300"))
# Kick Phase 2 (profile enrichment) is the opposite: a real GoLogin/Chromium
# session navigating up to KICK_PHASE2_TOP_N kick.com/{slug} pages behind
# Cloudflare. Budget like a full scrape, not like the pure-HTTP Phase 1.
KICK_PROFILE_SCRAPE_PATH = os.environ.get(
    "KICK_PROFILE_SCRAPE_PATH",
    str(Path.home() / "kick_profile_scrape.py"),
)
KICK_PHASE2_TOP_N = int(os.environ.get("KICK_PHASE2_TOP_N", "25"))
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


def captcha_terminal(job_id: str, error: str | None = None) -> None:
    """Captcha-solver-timeout path: mark the job as terminal 'captcha' without
    bumping captcha_attempts so the operator can manually re-queue from
    /admin/interactive. Distinct from captcha_job (which auto-retries
    up to 10 times) — running auto-retry on Captcha-solver-parked jobs
    would just burn proxy quota cycling the same captcha 10x in 20 minutes."""
    supabase.rpc(
        "mark_scrape_job_captcha_terminal",
        {"p_job_id": job_id, "p_error": (error or "Couldn't continue — a captcha appeared and nobody was around to solve it. Click 'Re-queue with Captcha solver' on the Interactive page to try again.")[:2000]},
    ).execute()


def fail_job(job_id: str, error: str) -> None:
    supabase.rpc("fail_scrape_job", {"p_job_id": job_id, "p_error": error[:2000]}).execute()


# ---------------------------------------------------------------------------
# Failure classification — turn raw subprocess stderr / Python exceptions
# into a one-line user-facing message for scrape_queue.error_message.
# ---------------------------------------------------------------------------
# Patterns are checked in order; first match wins. Both subprocess stderr
# tails and stringified Python exceptions are fed through the same matcher
# because most of the recognisable signatures (BadZipFile, WebDriver
# crashes, proxy errors) show up in either path.
_FAILURE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # ---- GoLogin profile transient (already auto-retried by scraper) ----
    (re.compile(r"BadZipFile|bad zip file", re.I),
     "GoLogin profile download glitched — auto-retry usually fixes this."),

    # ---- Browser / Selenium crashes ----
    (re.compile(r"chrome not reachable|DevToolsActivePort|chrome failed to start"
                r"|session not created|session deleted because of page crash", re.I),
     "Browser crashed during the scrape — auto-retry will run."),
    (re.compile(r"WebDriverException|InvalidSessionId|NoSuchWindowException", re.I),
     "Browser session died mid-scrape — auto-retry will run."),

    # ---- GoLogin API auth / profile issues ----
    (re.compile(r"GoLogin.*(401|403|forbidden|unauthorized)"
                r"|gologin.*api.*token", re.I),
     "GoLogin authentication failed — the API token may have expired."),
    (re.compile(r"profile (id )?not found|profile_id.*does not exist", re.I),
     "GoLogin profile is missing or was deleted — check the country config."),

    # ---- Proxy bandwidth / quota (Chris's '5 GB' scenario) ----
    (re.compile(r"(bandwidth|data|traffic|quota).*(exceeded|reached|out of|limit)"
                r"|out of (bandwidth|data|traffic)"
                r"|insufficient (balance|credit)", re.I),
     "Proxy ran out of bandwidth — rotate to a fresh proxy or top up the plan."),

    # ---- Proxy IP-check failure (geo.myip.link) — almost always bandwidth ----
    # The scraper hits geo.myip.link via the SOCKS proxy at startup to verify
    # its exit IP. If that very first proxied request fails, the proxy itself
    # is dead — usually because it ran out of bandwidth (Chris's '5 GB' scenario)
    # or its credentials expired. Must come BEFORE the generic SOCKS pattern.
    (re.compile(r"geo\.myip\.link", re.I),
     "Couldn't connect through the proxy at all — usually means the proxy ran out of bandwidth, or its credentials expired. Rotate to a fresh proxy or top up the plan."),

    # ---- Network / proxy failures ----
    (re.compile(r"ProxyError|proxy.*(refused|reset|timed? out|connection)"
                r"|TunnelError|SOCKS.*error", re.I),
     "Couldn't reach the site through the proxy — usually bandwidth ran out or the proxy is unreachable. Rotate to a fresh proxy or top up the plan."),
    (re.compile(r"Failed to establish a new connection|getaddrinfo failed"
                r"|name or service not known|temporary failure in name resolution", re.I),
     "Network error — couldn't reach the target site from this worker."),
    (re.compile(r"Read timed out|HTTPSConnectionPool.*timeout", re.I),
     "The target site took too long to respond — usually a slow proxy."),

    # ---- Captcha solver / captcha (defensive; markers should normally catch these) ----
    (re.compile(r"captcha|cloudflare.*(challenge|turnstile)|recaptcha", re.I),
     "Search engine showed a captcha that wasn't resolved in time."),

    # ---- Chromium GPU / WebGL log noise ----
    # Chromium constantly spams GPU driver warnings to stderr ("GPU stall due
    # to ReadPixels", "GL_CLOSE_PATH_NV", "WebGL-0x..."). These are harmless
    # on their own — the scrape was killed for another reason and this junk
    # just happened to be the last thing on stderr. Match early so it doesn't
    # leak into the fallback message shown to clients.
    (re.compile(r"gpu/command_buffer|GL_CLOSE_PATH_NV|GPU stall|WebGL-0x"
                r"|GL Driver Message|gpu_init|skia.*gpu", re.I),
     "Browser closed unexpectedly during the scrape. Auto-retry will run."),

    # ---- Sign-up / consent walls (Chris's meeting concern) ----
    (re.compile(r"sign[- ]?up|create.*account|consent.*wall|join now", re.I),
     "Search engine showed a sign-up wall — browser refresh didn't clear it."),

    # ---- Google login failure ----
    (re.compile(r"Couldn.?t sign you in|google[_ ]login.*fail"
                r"|account.*disabled|verify it.?s you", re.I),
     "Google sign-in failed — the saved credentials may be wrong or the account is challenged."),

    # ---- Worker setup / environment ----
    (re.compile(r"ModuleNotFoundError|ImportError", re.I),
     "Worker is missing a Python package — needs a pip install on the VM."),
    (re.compile(r"PermissionError|Permission denied", re.I),
     "Worker doesn't have permission to run a needed file on the VM."),
    (re.compile(r"FileNotFoundError|No such file or directory", re.I),
     "Worker can't find a required file on the VM."),
    (re.compile(r"MemoryError|Out of memory|Killed", re.I),
     "Worker ran out of memory mid-scrape — auto-retry will run."),
    (re.compile(r"Disk quota exceeded|No space left on device", re.I),
     "VM is out of disk space — clear /tmp logs and retry."),
)


def classify_failure(*, exit_code: int | None,
                     error_text: str | None,
                     source: str = "scraper") -> str:
    """Turn a raw subprocess stderr tail or stringified Python exception
    into a one-line friendly message for scrape_queue.error_message.

    Walks _FAILURE_PATTERNS in order; first match wins. Falls back to a
    sanitised short snippet (last ~180 chars, whitespace-collapsed) so
    nothing useful is lost when the pattern list doesn't cover a case —
    ops can still SSH in and read /tmp/scrape_vm1-*_*.log for full detail.

    source: 'scraper' or 'youtube_search' — only used in the fallback
    string so the user knows which path failed.
    """
    haystack = (error_text or "")[-2000:]
    for pattern, friendly in _FAILURE_PATTERNS:
        if pattern.search(haystack):
            return friendly

    # Negative exit codes from subprocess mean the process was killed by a
    # signal (abs(code) == signal number). -15 = SIGTERM, -9 = SIGKILL.
    # Almost always means the worker tore the scrape down (timeout, restart,
    # OOM) rather than a real error in the scraper itself.
    if exit_code is not None and exit_code < 0:
        return ("Scrape was stopped before it could finish "
                "(took too long, or the worker was restarted). "
                "Auto-retry will run.")

    return f"{source} couldn't finish — no specific cause detected. Try re-queueing; full log is on the VM."


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


def _upload_landing_screenshots(job_id: str, results: list[dict[str, Any]]) -> None:
    """Best-effort upload of per-PPC post-click landing-page screenshots.

    Mirrors _upload_serp_screenshots, but for the second screenshot the
    scraper now captures during the Ctrl+Click pass it does for URL
    resolution. The scraper drops PNGs at `/tmp/ppc_landing_*.png` and
    tags successful captures with `local_landing_screenshot=<path>`.
    Here we upload to the lead-screenshots bucket under
    `landing/<job_id>/<idx>.png` and rewrite the field to
    `screenshot_content_link` so complete_scrape_job persists it on
    the lead row alongside serp_screenshot_path. Failures are logged
    but never block the rest of the job — cloakers win some of these.
    """
    for idx, row in enumerate(results):
        local = row.pop("local_landing_screenshot", None)
        if not local or not os.path.exists(local):
            continue
        bucket_path = f"landing/{job_id}/{idx}_{int(time.time() * 1000)}.png"
        try:
            with open(local, "rb") as f:
                png = f.read()
            supabase.storage.from_(SERP_SCREENSHOT_BUCKET).upload(
                bucket_path,
                png,
                {"content-type": "image/png", "upsert": "true"},
            )
            row["screenshot_content_link"] = bucket_path
            log.info("uploaded PPC landing screenshot for job=%s idx=%d → %s",
                     job_id, idx, bucket_path)
        except Exception as exc:  # noqa: BLE001
            log.warning("Landing screenshot upload failed for job=%s idx=%d: %s",
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
    view_mode: str = "both",
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
    # view_mode is per-job (form dropdown) but the worker-level env var
    # MOBILE_PASS_ENABLED=off acts as a hard downgrade to desktop-only.
    # Useful when one country is captcha-prone enough that the extra
    # mobile-pass SERP load costs more than it gains.
    effective_view = view_mode if MOBILE_PASS_ENABLED else "desktop"
    cmd += ["--view-mode", effective_view]
    # Captcha solver is gated on two flags: CAPTCHA_SOLVER_MODE env var
    # (per-VM kill switch) AND system_settings.captcha_solver_enabled
    # (admin toggle via /admin/system). Both must be true. The DB lookup
    # happens once per job at this point — not per poll-loop iteration —
    # so the runtime cost is negligible.
    solver_active = bool(job_id) and captcha_solver_should_run()
    if solver_active:
        # When the Captcha solver is on, hand the scraper enough context
        # to write interactive_checkpoints rows. Subprocess timeout
        # also bumps so paused jobs don't get TERM'd while a human is
        # clicking through.
        cmd += [
            "--interactive",
            "--job-id", job_id,
            "--worker-id", WORKER_ID,
        ]
    timeout_s = INTERACTIVE_TIMEOUT_S if solver_active else SCRAPE_TIMEOUT_S

    # DISPLAY is set per-port in the scrape-worker@<port>.service systemd
    # drop-in so each worker writes to its own Xvfb. Don't override here
    # or noVNC isolation breaks (everyone lands on :1).
    env = os.environ.copy()
    log.info("launching scraper (port=%d profile=%s log=%s timeout=%ds interactive=%s)",
             GOLOGIN_PORT, profile_id[:8], log_path, timeout_s,
             "yes" if solver_active else "no")

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


def run_youtube_search(
    keyword: str,
    country_name: str,
    country_code: str,
    language: str,
    job_id: str,
    max_results: int = 50,
) -> tuple[int, str, Path, Path]:
    """Invoke youtube_search.py as a subprocess.

    Mirrors run_scrape()'s contract — combined stdout/stderr to a log
    file, summary JSON written by the child to output_path — so
    classify-the-outcome logic stays uniform. No GoLogin, no port,
    no view_mode: YouTube Data API is a plain HTTP call.

    Returns: (exit_code, combined_log_text, json_output_path, log_path)
    """
    output_path = Path(RESULTS_DIR) / f"youtube_{WORKER_ID}_{GOLOGIN_PORT}.json"
    log_path    = Path(RESULTS_DIR) / f"youtube_{WORKER_ID}_{GOLOGIN_PORT}.log"
    output_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)

    cmd = [
        "python3",
        "-u",   # unbuffered: [INFO] lines show in tail -f in real time
        YOUTUBE_SEARCH_PATH,
        "-k", keyword,
        "-c", country_name,
        "--country-code", country_code,
        "--language", language,
        "--max-results", str(max_results),
        "--job-id", job_id,
        "--worker-id", WORKER_ID,
        "--output", str(output_path),
    ]

    env = os.environ.copy()
    log.info("launching youtube_search (keyword=%r country=%s lang=%s log=%s timeout=%ds)",
             keyword, country_code, language, log_path, YOUTUBE_SEARCH_TIMEOUT_S)

    with open(log_path, "w", encoding="utf-8") as log_f:
        result = subprocess.run(
            cmd,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            timeout=YOUTUBE_SEARCH_TIMEOUT_S,
        )

    try:
        combined = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        combined = ""
    return result.returncode, combined, output_path, log_path


def process_youtube_job(job: dict[str, Any]) -> None:
    """Handle a scrape_queue row where search_engine='youtube'.

    Skips GoLogin profile lookup and the port-kill cycle (no Chromium
    spawned). Reuses the same complete_scrape_job / fail_scrape_job /
    active_profile_locks plumbing as Google/Bing so the queue state
    machine is identical. The lock is set on country_code at claim
    time and released by complete_scrape_job — for YouTube that just
    serializes per-country (cheap; YouTube jobs finish in ~5-10s).

    Phase 2 jobs (operator-triggered ▶ contact enrichment) carry a
    parent_scrape_job_id and take the *browser* path instead — they need
    a real GoLogin session to open each channel's About tab and clear the
    reCAPTCHA email gate.
    """
    if job.get("parent_scrape_job_id"):
        process_youtube_phase2_job(job)
        return

    job_id = job["id"]
    country_code = job["country_code"]
    keyword = job["keyword"]
    language = (job.get("language") or "en").strip().lower() or "en"

    log.info("claimed youtube job %s | country=%s keyword=%r lang=%s",
             job_id, country_code, keyword, language)

    # country_name is logged-only for YouTube (regionCode is what the API
    # actually uses); look it up best-effort so logs are readable, but
    # don't fail the job if the profile row is missing.
    profile = fetch_profile(country_code) or {}
    country_name = profile.get("country_name") or country_code

    try:
        exit_code, combined_log, output_path, log_path = run_youtube_search(
            keyword=keyword,
            country_name=country_name,
            country_code=country_code,
            language=language,
            job_id=job_id,
        )
    except subprocess.TimeoutExpired:
        fail_job(job_id, f"YouTube search took too long ({YOUTUBE_SEARCH_TIMEOUT_S}s) and was stopped.")
        return
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, classify_failure(exit_code=None, error_text=str(exc), source="youtube_search"))
        return

    if "[RESULT] SUCCESS" not in combined_log:
        fail_job(job_id, classify_failure(exit_code=exit_code, error_text=combined_log, source="youtube_search"))
        return

    if not output_path.exists():
        fail_job(job_id, "YouTube search finished but the results file is missing on disk — likely a file-system or permissions issue.")
        return
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "YouTube search finished but the results file is corrupted — re-run usually fixes this.")
        return

    # Channels are already in public.youtube_channels (the child wrote
    # them directly via Supabase). complete_scrape_job's leads-insert
    # loop iterates over p_results — passing [] makes it a no-op, while
    # the summary + status update still fire and the active_profile_lock
    # is released. Same atomic-RPC path as Google/Bing.
    summary = {
        "total_results": payload.get("total_results"),
        "organic_results": payload.get("organic_results"),
        "ppc_results": payload.get("ppc_results"),
        "pages_scraped": payload.get("pages_scraped"),
        "scraped_at": payload.get("timestamp"),
        "is_logged_in": None,
        "view_mode": "desktop",   # YouTube has no mobile/desktop split
    }
    try:
        complete_job(job_id, [], summary)
    except Exception as exc:  # noqa: BLE001
        log.error("complete_scrape_job RPC failed for youtube job %s: %s", job_id, exc)
        return

    log.info("youtube job %s completed | %d channels", job_id, summary.get("total_results") or 0)


def run_kick_search(
    keyword: str,
    country_name: str,
    country_code: str,
    language: str,
    job_id: str,
    max_results: int = 100,
) -> tuple[int, str, Path, Path]:
    """Invoke kick_search.py as a subprocess.

    Mirrors run_youtube_search()'s contract exactly — combined
    stdout/stderr to a log file, summary JSON written by the child
    to output_path. No GoLogin, no port, no view_mode: Kick is
    plain HTTP against api.kick.com + an OAuth token call.

    Returns: (exit_code, combined_log_text, json_output_path, log_path)
    """
    output_path = Path(RESULTS_DIR) / f"kick_{WORKER_ID}_{GOLOGIN_PORT}.json"
    log_path    = Path(RESULTS_DIR) / f"kick_{WORKER_ID}_{GOLOGIN_PORT}.log"
    output_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)

    cmd = [
        "python3",
        "-u",   # unbuffered: [INFO] lines show in tail -f in real time
        KICK_SEARCH_PATH,
        "-k", keyword,
        "-c", country_name,
        "--country-code", country_code,
        "--language", language,
        "--max-results", str(max_results),
        "--job-id", job_id,
        "--worker-id", WORKER_ID,
        "--output", str(output_path),
    ]

    env = os.environ.copy()
    log.info("launching kick_search (keyword=%r lang=%s log=%s timeout=%ds)",
             keyword, language, log_path, KICK_SEARCH_TIMEOUT_S)

    with open(log_path, "w", encoding="utf-8") as log_f:
        result = subprocess.run(
            cmd,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            timeout=KICK_SEARCH_TIMEOUT_S,
        )

    try:
        combined = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        combined = ""
    return result.returncode, combined, output_path, log_path


def process_kick_job(job: dict[str, Any]) -> None:
    """Handle a scrape_queue row where search_engine='kick'.

    Pure-API path like YouTube — no Chromium, no GoLogin profile,
    no port-kill cycle. The active_profile_lock on country_code is
    still set at claim time and released by complete_scrape_job;
    for Kick (where country is unused) that just serializes per
    country-row, which is harmless given the few-second runtime.

    Phase 2 jobs (operator-triggered ▶ profile enrichment) carry a
    parent_scrape_job_id and take the *browser* path instead — they
    need a real GoLogin session to clear Cloudflare on kick.com/{slug}.
    """
    if job.get("parent_scrape_job_id"):
        process_kick_phase2_job(job)
        return

    job_id = job["id"]
    country_code = job["country_code"]
    keyword = job["keyword"]
    language = (job.get("language") or "en").strip().lower() or "en"

    log.info("claimed kick job %s | country=%s keyword=%r lang=%s",
             job_id, country_code, keyword, language)

    profile = fetch_profile(country_code) or {}
    country_name = profile.get("country_name") or country_code

    try:
        exit_code, combined_log, output_path, log_path = run_kick_search(
            keyword=keyword,
            country_name=country_name,
            country_code=country_code,
            language=language,
            job_id=job_id,
        )
    except subprocess.TimeoutExpired:
        fail_job(job_id, f"Kick search took too long ({KICK_SEARCH_TIMEOUT_S}s) and was stopped.")
        return
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, classify_failure(exit_code=None, error_text=str(exc), source="kick_search"))
        return

    if "[RESULT] SUCCESS" not in combined_log:
        fail_job(job_id, classify_failure(exit_code=exit_code, error_text=combined_log, source="kick_search"))
        return

    if not output_path.exists():
        fail_job(job_id, "Kick search finished but the results file is missing on disk — likely a file-system or permissions issue.")
        return
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "Kick search finished but the results file is corrupted — re-run usually fixes this.")
        return

    # Streamers are already in public.kick_streamers (the child wrote
    # them directly via Supabase). Passing [] to complete_scrape_job
    # makes the leads-insert a no-op, while the summary + status
    # update still fire and the active_profile_lock is released.
    summary = {
        "total_results": payload.get("total_results"),
        "organic_results": payload.get("organic_results"),
        "ppc_results": payload.get("ppc_results"),
        "pages_scraped": payload.get("pages_scraped"),
        "scraped_at": payload.get("timestamp"),
        "is_logged_in": None,
        "view_mode": "desktop",   # Kick has no mobile/desktop split
    }
    try:
        complete_job(job_id, [], summary)
    except Exception as exc:  # noqa: BLE001
        log.error("complete_scrape_job RPC failed for kick job %s: %s", job_id, exc)
        return

    log.info("kick job %s completed | %d streamers", job_id, summary.get("total_results") or 0)


def run_kick_profile_scrape(
    profile_id: str,
    parent_job_id: str,
    job_id: str,
    top_n: int,
) -> tuple[int, str, Path, Path]:
    """Invoke kick_profile_scrape.py (Phase 2) as a subprocess.

    Unlike run_kick_search (pure HTTP), this is the *browser* path — it
    needs the GoLogin profile + port exactly like run_scrape, because
    kick.com/{slug} sits behind Cloudflare. Captcha-solver gating mirrors
    run_scrape: when active, hand the child --interactive/--job-id and use
    the longer interactive timeout so a paused job isn't TERM'd while a
    human clicks through noVNC.

    Returns: (exit_code, combined_log_text, json_output_path, log_path)
    """
    output_path = Path(RESULTS_DIR) / f"kick_phase2_{WORKER_ID}_{GOLOGIN_PORT}.json"
    log_path    = Path(RESULTS_DIR) / f"kick_phase2_{WORKER_ID}_{GOLOGIN_PORT}.log"
    output_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)

    cmd = [
        "python3",
        "-u",
        KICK_PROFILE_SCRAPE_PATH,
        profile_id,
        "--port", str(GOLOGIN_PORT),
        "--parent-job-id", parent_job_id,
        "--top-n", str(top_n),
        "--job-id", job_id,
        "--worker-id", WORKER_ID,
        "--output", str(output_path),
    ]
    if captcha_solver_should_run():
        cmd += ["--interactive"]

    env = os.environ.copy()
    log.info("launching kick_profile_scrape (port=%d profile=%s parent=%s top_n=%d log=%s)",
             GOLOGIN_PORT, profile_id[:8], parent_job_id[:8], top_n, log_path)

    timeout_s = INTERACTIVE_TIMEOUT_S if captcha_solver_should_run() else SCRAPE_TIMEOUT_S
    with open(log_path, "w", encoding="utf-8") as log_f:
        result = subprocess.run(
            cmd,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            timeout=timeout_s,
        )

    try:
        combined = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        combined = ""
    return result.returncode, combined, output_path, log_path


def process_kick_phase2_job(job: dict[str, Any]) -> None:
    """Handle a Kick Phase-2 enrichment job (search_engine='kick' with a
    parent_scrape_job_id). Browser path: look up the country's GoLogin
    profile, run kick_profile_scrape.py over the parent job's top-N
    un-enriched streamers, then complete (streamers are written directly
    to kick_streamers / kick_links by the child)."""
    job_id = job["id"]
    country_code = job["country_code"]
    parent_job_id = job["parent_scrape_job_id"]

    log.info("claimed kick PHASE 2 job %s | parent=%s country=%s",
             job_id, parent_job_id, country_code)

    profile = fetch_profile(country_code)
    if not profile or not profile.get("gologin_profile_id"):
        fail_job(job_id, f"No gologin_profile_id configured for country_code={country_code}")
        return
    profile_id = profile["gologin_profile_id"]

    _kill_port()

    try:
        exit_code, combined_log, output_path, log_path = run_kick_profile_scrape(
            profile_id=profile_id,
            parent_job_id=parent_job_id,
            job_id=job_id,
            top_n=KICK_PHASE2_TOP_N,
        )
    except subprocess.TimeoutExpired:
        _kill_port()
        timeout_used = INTERACTIVE_TIMEOUT_S if CAPTCHA_SOLVER_MODE else SCRAPE_TIMEOUT_S
        fail_job(job_id, f"Kick profile enrichment took too long ({timeout_used // 60} min) and was stopped.")
        return
    except Exception as exc:  # noqa: BLE001
        _kill_port()
        fail_job(job_id, classify_failure(exit_code=None, error_text=str(exc), source="scraper"))
        return

    if "[RESULT] SUCCESS" not in combined_log:
        _kill_port()
        fail_job(job_id, classify_failure(exit_code=exit_code, error_text=combined_log, source="scraper"))
        return

    _kill_port()

    if not output_path.exists():
        fail_job(job_id, "Kick profile enrichment finished but the results file is missing on disk.")
        return
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        fail_job(job_id, "Kick profile enrichment finished but the results file is corrupted — re-run usually fixes this.")
        return

    # Streamers are already updated in kick_streamers; pass [] so the
    # leads-insert is a no-op while status + summary update and the
    # active_profile_lock is released.
    summary = {
        "total_results": payload.get("total_results"),
        "organic_results": payload.get("organic_results"),
        "ppc_results": payload.get("ppc_results"),
        "pages_scraped": payload.get("pages_scraped"),
        "scraped_at": payload.get("timestamp"),
        "is_logged_in": None,
        "view_mode": "desktop",
    }
    try:
        complete_job(job_id, [], summary)
    except Exception as exc:  # noqa: BLE001
        log.error("complete_scrape_job RPC failed for kick phase 2 job %s: %s", job_id, exc)
        return

    log.info("kick phase 2 job %s completed | %d streamers enriched (%d attempted, %d failed)",
             job_id, payload.get("total_results") or 0,
             payload.get("attempted") or 0, payload.get("failed") or 0)


def run_youtube_profile_scrape(
    profile_id: str,
    parent_job_id: str,
    job_id: str,
    top_n: int,
) -> tuple[int, str, Path, Path]:
    """Invoke youtube_profile_scrape.py (Phase 2) as a subprocess.

    The *browser* path — like run_kick_profile_scrape, it needs the GoLogin
    profile + port (the channel About tab's email is reCAPTCHA-gated and the
    Links section lazy-renders). Captcha-solver gating mirrors run_scrape:
    when active, hand the child --interactive/--job-id and use the longer
    interactive timeout so a paused job isn't TERM'd mid-checkpoint.

    Returns: (exit_code, combined_log_text, json_output_path, log_path)
    """
    output_path = Path(RESULTS_DIR) / f"youtube_phase2_{WORKER_ID}_{GOLOGIN_PORT}.json"
    log_path    = Path(RESULTS_DIR) / f"youtube_phase2_{WORKER_ID}_{GOLOGIN_PORT}.log"
    output_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)

    cmd = [
        "python3",
        "-u",
        YOUTUBE_PROFILE_SCRAPE_PATH,
        profile_id,
        "--port", str(GOLOGIN_PORT),
        "--parent-job-id", parent_job_id,
        "--top-n", str(top_n),
        "--job-id", job_id,
        "--worker-id", WORKER_ID,
        "--output", str(output_path),
    ]
    if captcha_solver_should_run():
        cmd += ["--interactive"]

    env = os.environ.copy()
    log.info("launching youtube_profile_scrape (port=%d profile=%s parent=%s top_n=%d log=%s)",
             GOLOGIN_PORT, profile_id[:8], parent_job_id[:8], top_n, log_path)

    timeout_s = INTERACTIVE_TIMEOUT_S if captcha_solver_should_run() else SCRAPE_TIMEOUT_S
    with open(log_path, "w", encoding="utf-8") as log_f:
        result = subprocess.run(
            cmd,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            timeout=timeout_s,
        )

    try:
        combined = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        combined = ""
    return result.returncode, combined, output_path, log_path


def process_youtube_phase2_job(job: dict[str, Any]) -> None:
    """Handle a YouTube Phase-2 enrichment job (search_engine='youtube' with
    a parent_scrape_job_id). Browser path: look up the country's GoLogin
    profile, run youtube_profile_scrape.py over the parent job's top-N
    un-enriched channels, then complete (channels are updated directly in
    youtube_channels by the child)."""
    job_id = job["id"]
    country_code = job["country_code"]
    parent_job_id = job["parent_scrape_job_id"]

    log.info("claimed youtube PHASE 2 job %s | parent=%s country=%s",
             job_id, parent_job_id, country_code)

    profile = fetch_profile(country_code)
    if not profile or not profile.get("gologin_profile_id"):
        fail_job(job_id, f"No gologin_profile_id configured for country_code={country_code}")
        return
    profile_id = profile["gologin_profile_id"]

    _kill_port()

    try:
        exit_code, combined_log, output_path, log_path = run_youtube_profile_scrape(
            profile_id=profile_id,
            parent_job_id=parent_job_id,
            job_id=job_id,
            top_n=YOUTUBE_PHASE2_TOP_N,
        )
    except subprocess.TimeoutExpired:
        _kill_port()
        timeout_used = INTERACTIVE_TIMEOUT_S if CAPTCHA_SOLVER_MODE else SCRAPE_TIMEOUT_S
        fail_job(job_id, f"YouTube contact enrichment took too long ({timeout_used // 60} min) and was stopped.")
        return
    except Exception as exc:  # noqa: BLE001
        _kill_port()
        fail_job(job_id, classify_failure(exit_code=None, error_text=str(exc), source="scraper"))
        return

    if "[RESULT] SUCCESS" not in combined_log:
        _kill_port()
        fail_job(job_id, classify_failure(exit_code=exit_code, error_text=combined_log, source="scraper"))
        return

    _kill_port()

    if not output_path.exists():
        fail_job(job_id, "YouTube contact enrichment finished but the results file is missing on disk.")
        return
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        fail_job(job_id, "YouTube contact enrichment finished but the results file is corrupted — re-run usually fixes this.")
        return

    # Channels are already updated in youtube_channels; pass [] so the
    # leads-insert is a no-op while status + summary update and the
    # active_profile_lock is released.
    summary = {
        "total_results": payload.get("total_results"),
        "organic_results": payload.get("organic_results"),
        "ppc_results": payload.get("ppc_results"),
        "pages_scraped": payload.get("pages_scraped"),
        "scraped_at": payload.get("timestamp"),
        "is_logged_in": None,
        "view_mode": "desktop",
    }
    try:
        complete_job(job_id, [], summary)
    except Exception as exc:  # noqa: BLE001
        log.error("complete_scrape_job RPC failed for youtube phase 2 job %s: %s", job_id, exc)
        return

    log.info("youtube phase 2 job %s completed | %d channels enriched (%d attempted, %d failed)",
             job_id, payload.get("total_results") or 0,
             payload.get("attempted") or 0, payload.get("failed") or 0)


def process_job(job: dict[str, Any]) -> None:
    job_id = job["id"]
    country_code = job["country_code"]
    keyword = job["keyword"]
    pages = int(job.get("pages") or 1)
    # Accept missing `language` for backwards compatibility with old rows
    # that pre-date the migration that added the column.
    language = (job.get("language") or "en").strip().lower() or "en"
    engine = (job.get("search_engine") or "google").strip().lower() or "google"
    if engine not in ("google", "bing", "youtube", "kick"):
        engine = "google"

    # YouTube and Kick jobs take a completely different path — pure
    # HTTP API calls, no GoLogin / Selenium / port management. Branch
    # out before the profile lookup and never reach the scrape pipeline
    # below.
    if engine == "youtube":
        process_youtube_job(job)
        return
    if engine == "kick":
        process_kick_job(job)
        return

    # view_mode controls whether scraper.py runs the desktop pass, the
    # mobile (iPhone UA + 375x812 viewport) pass, or both. Default
    # 'both' for jobs from before the migration landed.
    view_mode = (job.get("view_mode") or "both").strip().lower() or "both"
    if view_mode not in ("desktop", "mobile", "both"):
        view_mode = "both"

    log.info("claimed job %s | country=%s keyword=%r pages=%d lang=%s engine=%s view=%s",
             job_id, country_code, keyword, pages, language, engine, view_mode)

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
            view_mode=view_mode,
        )
    except subprocess.TimeoutExpired:
        _kill_port()
        timeout_used = INTERACTIVE_TIMEOUT_S if CAPTCHA_SOLVER_MODE else SCRAPE_TIMEOUT_S
        fail_job(job_id, f"Scrape took too long ({timeout_used // 60} min) and was stopped.")
        return
    except Exception as exc:  # noqa: BLE001
        _kill_port()
        fail_job(job_id, classify_failure(exit_code=None, error_text=str(exc), source="scraper"))
        return

    # Classify the outcome by the [RESULT] marker the scraper prints.
    # SUCCESS wins over any earlier captcha markers: a scrape can emit
    # CAPTCHA_SOLVER_TIMEOUT mid-run (e.g. an optional Google-login
    # Captcha solver window nobody clicked) and still go on to produce
    # results. If the final [RESULT] SUCCESS line is there, the results
    # are real — don't throw them away because of a non-blocking earlier
    # checkpoint.
    if "[RESULT] SUCCESS" in combined_log:
        pass  # fall through to the results-loading path below
    elif "[RESULT] CAPTCHA_SOLVER_TIMEOUT" in combined_log:
        # Operator didn't click Resume within captcha_solver_ttl_minutes
        # and the scrape couldn't recover. Route to the terminal path
        # (no auto-retry) so the operator can manually re-queue from
        # /admin/interactive — see mark_scrape_job_captcha_terminal vs
        # captcha_scrape_job.
        log.warning("job %s Captcha solver timed out (log=%s) — marking terminal captcha", job_id, log_path)
        _kill_port()
        captcha_terminal(job_id)
        return
    elif "[RESULT] CAPTCHA" in combined_log:
        log.warning("job %s hit CAPTCHA (log=%s)", job_id, log_path)
        _kill_port()
        captcha_job(job_id)
        return
    else:
        _kill_port()
        fail_job(job_id, classify_failure(exit_code=exit_code, error_text=combined_log, source="scraper"))
        return

    # Load the results JSON the scraper dropped for us
    if not output_path.exists():
        _kill_port()
        fail_job(job_id, "Scraper finished but the results file is missing on disk — likely a file-system or permissions issue.")
        return
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        _kill_port()
        fail_job(job_id, "Scraper finished but the results file is corrupted — re-run usually fixes this.")
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
        # Mobile-pass diagnostics so /scrape can surface them and we can
        # tell at-a-glance whether the mobile pass ran, found anything,
        # or aborted on captcha.
        "view_mode": view_mode,
        "mobile_only_results": payload.get("mobile_only_results"),
        "cross_device_results": payload.get("cross_device_results"),
        "mobile_pass_skipped": payload.get("mobile_pass_skipped"),
    }

    # Upload any per-PPC SERP screenshots the scraper saved to /tmp.
    # Replaces local_serp_screenshot (a /tmp path) with serp_screenshot_path
    # (a bucket-relative path) on each result row before the RPC fires.
    _upload_serp_screenshots(job_id, results)

    # Same for the post-click landing-page screenshot; rewrites
    # local_landing_screenshot → screenshot_content_link.
    _upload_landing_screenshots(job_id, results)

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
