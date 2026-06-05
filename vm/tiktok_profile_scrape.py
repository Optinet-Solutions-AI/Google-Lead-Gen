"""
TikTok creator profile enrichment worker (Phase 2).

Called as a subprocess by vm/worker.py for TikTok scrape_queue jobs that carry
a parent_scrape_job_id (an operator-triggered ▶ "enrich profiles" job).
Phase 1 (tiktok_search.py) discovers creator handles. Phase 2 renders each
tiktok.com/@{handle} in the GoLogin session and reads the page's
__UNIVERSAL_DATA_FOR_REHYDRATION__ JSON (confirmed by the 2026-06-05 recon
probe) to backfill the fields that only live on the profile:

  - bio (signature), bio_link (the single profile link — the funnel),
    follower_count / following_count / video_count / heart_count, verified,
    user_id, display_name (nickname)
  - recent video captions (best-effort, from the rendered post grid)
and inserts public.tiktok_links rows with source 'bio_link' (the profile link)
and 'video_caption' (any URLs in recent captions) — the affiliate/casino link
surfaces Phase 3 scores.

Modelled on vm/x_profile_scrape.py with ONE deliberate difference: NO LOGIN
WALL. TikTok serves profiles logged-out through the resi proxy, so there is no
ensure_logged_in() gate. Like x_profile_scrape.py it uses ONE GoLogin session
for the whole batch (a fresh session per profile would waste proxy bring-up).

Reuses vm/scraper.py's GoLogin/Selenium/captcha plumbing by import
(co-located in ~/ on the VM). scraper.py's main() is __main__-guarded.

CLI mirrors x_profile_scrape.py (profile_id positional, --port,
--parent-job-id, --top-n, the [RESULT] marker, summary JSON to --output) so
worker.py's dispatch path stays uniform.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed
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

TT_BASE = "https://www.tiktok.com"

TT_MAX_TRIES = int(os.environ.get("TT_PHASE2_MAX_TRIES", "3"))
TT_INTER_PROFILE_DELAY_S = int(os.environ.get("TT_PHASE2_PROFILE_DELAY_SECONDS", "4"))
TT_BLOCK_COOLDOWN_S = int(os.environ.get("TT_PHASE2_BLOCK_COOLDOWN_SECONDS", "12"))
# Wall-clock budget: stop starting NEW profiles past this, finish what's done,
# exit SUCCESS — so the worker never kills us mid-run. Un-enriched creators
# stay pending for a re-run. Kept under the non-interactive worker timeout.
TT_BUDGET_S = int(os.environ.get("TT_PHASE2_BUDGET_SECONDS", "1000"))

# http(s) URL run in caption text — stops at whitespace / common delimiters.
_URL_RE = re.compile(r"https?://[^\s)>\]\"']+", re.I)


# ---------------------------------------------------------------------------
# Profile extraction — from the page's rehydration JSON (durable across
# TikTok's class-name churn; the data-e2e hooks are the DOM fallback).
# ---------------------------------------------------------------------------

_PROFILE_JS = r"""
const res = { ok: false, captions: [] };
try {
  const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (el && el.textContent) {
    const scope = (JSON.parse(el.textContent).__DEFAULT_SCOPE__) || {};
    const ud = scope['webapp.user-detail'];
    const info = ud && ud.userInfo;
    if (info && info.user) {
      const u = info.user, st = info.stats || info.statsV2 || {};
      const num = v => (v === undefined || v === null) ? null : Number(v);
      res.ok = true;
      res.user_id = u.id || null;
      res.username = u.uniqueId || null;
      res.nickname = u.nickname || null;
      res.signature = (u.signature || '').slice(0, 2000) || null;
      res.bio_link = (u.bioLink && u.bioLink.link) || null;
      res.verified = !!u.verified;
      res.follower_count = num(st.followerCount);
      res.following_count = num(st.followingCount);
      res.video_count = num(st.videoCount);
      res.heart_count = num(st.heartCount != null ? st.heartCount : st.heart);
    } else if (ud && ud.statusCode && ud.statusCode !== 0) {
      res.unavailable = true;
    }
  }
} catch (e) { res.error = String(e).slice(0, 200); }

// DOM fallback for bio / bio-link when the JSON is absent.
if (!res.signature) {
  const b = document.querySelector('[data-e2e="user-bio"]');
  if (b) res.signature = (b.innerText || '').trim().slice(0, 2000) || null;
}
if (!res.bio_link) {
  const l = document.querySelector('[data-e2e="user-link"]');
  if (l) res.bio_link = (l.getAttribute('href') || l.innerText || '').trim() || null;
}

// Recent video captions — the post-grid item images carry the caption in alt.
const seen = new Set();
for (const img of document.querySelectorAll('[data-e2e="user-post-item"] img[alt], a[href*="/video/"] img[alt]')) {
  const alt = (img.getAttribute('alt') || '').trim();
  if (alt && !seen.has(alt)) { seen.add(alt); res.captions.push(alt.slice(0, 300)); }
  if (res.captions.length >= 12) break;
}
return res;
"""


def _normalize_link(url: str) -> str:
    url = (url or "").strip()
    if url and not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url


def parse_profile(driver) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    """Run the JS extractor and shape it into (tiktok_creators fields,
    tiktok_links rows, unavailable). A profile with a follower count (every
    account has one, even 0) is treated as successfully enriched."""
    raw = driver.execute_script(_PROFILE_JS) or {}

    if raw.get("unavailable"):
        return {}, [], True

    fields: dict[str, Any] = {}
    if raw.get("nickname"):
        fields["display_name"] = raw["nickname"]
    if raw.get("signature") is not None:
        fields["bio"] = raw["signature"]
    if raw.get("user_id"):
        fields["user_id"] = raw["user_id"]
    fields["verified"] = bool(raw.get("verified"))
    for src, col in (
        ("follower_count", "follower_count"),
        ("following_count", "following_count"),
        ("video_count", "video_count"),
        ("heart_count", "heart_count"),
    ):
        v = raw.get(src)
        if isinstance(v, (int, float)):
            fields[col] = int(v)

    bio_link = _normalize_link(raw.get("bio_link") or "")
    if bio_link:
        fields["bio_link"] = bio_link

    captions = [c for c in (raw.get("captions") or []) if c]
    if captions:
        fields["recent_video_captions"] = captions

    # Build tiktok_links rows (first occurrence of each url wins).
    links: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_link(url: str, source: str) -> None:
        url = _normalize_link(url)
        if not url or url in seen:
            return
        seen.add(url)
        links.append({"url": url, "source": source})

    if bio_link:
        add_link(bio_link, "bio_link")
    for cap in captions:
        for m in _URL_RE.findall(cap):
            add_link(m.rstrip(".,);"), "video_caption")

    return fields, links, False


def _profile_unavailable_dom(driver) -> bool:
    """Body-text fallback for a suspended / non-existent account."""
    try:
        body = driver.find_element("tag name", "body").text or ""
    except Exception:  # noqa: BLE001
        body = ""
    return ("Couldn't find this account" in body or "couldn't find this account" in body.lower())


def enrich_one(driver, username: str) -> dict[str, Any]:
    """Navigate tiktok.com/@{username}, extract from the rehydration JSON.

    Returns {"ok": bool, "fields": {...}, "links": [...], "permanent"?: bool}.
    ok=False with permanent=True means the account is gone (don't retry);
    ok=False otherwise means a transient block (leave pending for a re-run)."""
    url = f"{TT_BASE}/@{username}"
    try:
        driver.get(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {username}: navigation failed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    time.sleep(4)  # let the SPA hydrate the rehydration JSON

    try:
        fields, links, unavailable = parse_profile(driver)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {username}: extraction crashed: {exc}", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    if unavailable or _profile_unavailable_dom(driver):
        print(f"[INFO] {username}: account suspended / doesn't exist", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": [], "permanent": True}

    if "follower_count" not in fields:
        # The rehydration JSON never appeared (block / rate-limit). Every real
        # account has a follower count — retry on a fresh attempt rather than
        # record a false "enriched".
        print(f"[WARN] {username}: profile did not hydrate (no follower count)", file=sys.stderr)
        return {"ok": False, "fields": {}, "links": []}

    return {"ok": True, "fields": fields, "links": links}


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def fetch_target_creators(sb, parent_job_id: str, top_n: int) -> list[dict[str, Any]]:
    """Top-N not-yet-enriched creators of the parent Phase-1 job. No follower
    count yet (Phase 2 fills it), so order by discovery order (id)."""
    res = (
        sb.table("tiktok_creators")
        .select("id, username")
        .eq("scrape_queue_id", parent_job_id)
        .is_("about_scraped_at", "null")
        .order("id", desc=False)
        .limit(top_n)
        .execute()
    )
    return res.data or []


def write_enrichment(sb, creator_id: str, fields: dict[str, Any], links: list[dict[str, Any]]) -> None:
    update = dict(fields)
    update["about_fetch_failed"] = False
    update["about_scraped_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sb.table("tiktok_creators").update(update).eq("id", creator_id).execute()
    if links:
        rows = [{**l, "tiktok_creator_id": creator_id} for l in links]
        sb.table("tiktok_links").insert(rows).execute()


def mark_failed(sb, creator_id: str) -> None:
    sb.table("tiktok_creators").update({"about_fetch_failed": True}).eq("id", creator_id).execute()


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
        "is_logged_in": False,
        "results": [],
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


# ---------------------------------------------------------------------------
# GoLogin lifecycle (mirrors x_profile_scrape.py: one session for the whole
# batch, loop, time-budget guard, teardown). No login gate.
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
    for attempt in range(1, TT_MAX_TRIES + 1):
        try:
            print(f"[INFO] GoLogin session bring-up (attempt {attempt}/{TT_MAX_TRIES})")
            debugger_address = gl.start()
            time.sleep(2)
            driver = scraper_mod.connect_to_gologin_browser(debugger_address)
            scraper_mod._install_turnstile_interceptor(driver)
            if not scraper_mod.check_browser_connectivity(driver):
                raise RuntimeError("Browser connectivity check failed — proxy may be unreachable")
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
            if attempt < TT_MAX_TRIES:
                time.sleep(TT_BLOCK_COOLDOWN_S)

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
            if args.mode != "probe" and (enriched + failed) > 0 and (time.time() - run_start) > TT_BUDGET_S:
                remaining = len(targets) - attempted
                print(f"[INFO] time budget ({TT_BUDGET_S}s) reached — stopping with "
                      f"{remaining} creator(s) still pending (re-run to continue)")
                break

            username = t["username"]
            attempted += 1
            try:
                result = enrich_one(driver, username)
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
                print(f"----- tiktok_links ({len(result.get('links', []))}) -----")
                print(json.dumps(result.get("links", []), indent=2, default=str))
                print(f"===== END PROBE {username} =====\n")
                continue

            if not result["ok"]:
                failed += 1
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

            time.sleep(TT_INTER_PROFILE_DELAY_S)  # pace requests
    finally:
        _teardown(driver, gl)

    if args.mode == "probe":
        print("[RESULT] SUCCESS")
        return 0

    _write_summary(args.output, args.parent_job_id, attempted, enriched, failed)
    print(f"[DONE] TikTok Phase 2 | attempted={attempted} enriched={enriched} failed={failed}")
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
    parser = argparse.ArgumentParser(description="TikTok creator profile enrichment (Phase 2)")
    parser.add_argument("profile_id", help="GoLogin profile ID (resi proxy; no login needed)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["enrich", "probe"], default="enrich",
                        help="'enrich' (default) backfills DB; 'probe' dumps one --username, no DB")
    parser.add_argument("--username", default=None, help="(probe mode) single @handle to dump (no @)")
    parser.add_argument("--parent-job-id", dest="parent_job_id", default=None,
                        help="Phase-1 scrape_queue.id whose creators to enrich")
    parser.add_argument("--top-n", dest="top_n", type=int, default=25,
                        help="Max creators to enrich this run")
    parser.add_argument("--job-id", dest="job_id", default=None,
                        help="This Phase-2 scrape_queue.id (for captcha checkpoints)")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--country-code", dest="country_code", default="", help="ISO-2 of the profile (logged)")
    parser.add_argument("--output", default="/tmp/tiktok_phase2.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Park on noVNC if TikTok throws a checkpoint instead of failing")
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
