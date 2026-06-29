"""
Facebook Ad Library advertiser search worker (Phase 1).

Called as a subprocess by vm/worker.py for jobs where
scrape_queue.search_engine = 'facebook' that DON'T carry a
parent_scrape_job_id.

Modelled on vm/x_search.py (the proven browser-path template) with two
deliberate differences:

  1. ENTITY = advertiser PAGE, not a creator. The Ad Library is ad-centric;
     we aggregate the ad cards up to the Page running them. Each fb_advertisers
     row is one Page (page_id, page_name, page_url, how many of its ads we saw,
     a sample of its ad copy). Ads themselves are evidence, not their own rows.

  2. NO LOGIN WALL (no-login-first). The public Ad Library is browseable
     logged-out in most regions, so — unlike x_search.py — there is no
     ensure_logged_in() gate, no burner account, no is_*_logged_in flag. We
     navigate logged-out through the GoLogin/Selenium session (for the resi
     proxy + fingerprint) and only fall back to the captcha-solver checkpoint
     if Facebook throws an interstitial. If FB ever hard-gates logged-out, the
     follow-up is the X-style logged-in-burner path (a separate decision).

This is the SINGLE scrape pass for Facebook. A per-Page "Phase 2" enrichment
(opening each Page's full Ad Library view via ?view_all_page_id=) was dropped
2026-06-04: FB's numeric profile id is NOT the Ad Library page id, so that view
returns "no ads". Instead this discovery pass captures the ad landing links
straight from the search cards (cardLinks() below) — which is where FB reliably
exposes them.

Captures, per discovered advertiser Page, into public.fb_advertisers:
  - page_id (FB numeric Page id when the profile URL is numeric), page_name,
    page_url
  - ad_count (how many of this Page's ads appeared for the keyword)
  - ad_text_sample (concatenated/sampled ad copy — the scorer's keyword
    surface, since Pages have no bio)
  - discovered_from_keyword
and the ad landing links into public.fb_links (source 'ad_landing'): the
l.facebook.com/l.php?u= destinations (unwrapped, carrying any affiliate stag)
plus the display domains shown in the ad copy. Phase 3 (runFbAdvertiserAnalysis,
in-app) resolves the shorteners, parses S-tags, checks Monday, and scores.

Reuses vm/scraper.py's GoLogin/Selenium plumbing by import (co-located in ~/
on the VM, so `import scraper` resolves to ~/scraper.py). scraper.py's main()
is __main__-guarded, so importing it has no side effects.

CLI mirrors x_search.py's contract (profile_id positional, --port, the
[RESULT] marker, a summary JSON to --output) so worker.py's dispatch path
stays uniform.

  exit 1 — env vars missing / bad args
  exit 2 — GoLogin / browser bring-up failed
  exit 3 — Supabase write failure

A separate --mode probe (does not touch the DB) runs the search for an
explicit --query and dumps the parsed advertisers to stdout — the one-time VM
spike that confirms the DOM parser matches the Ad Library markup before it's
hardened. The Ad Library grid markup is the #1 risk; selectors below are
best-effort until that probe.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib.parse import quote
from typing import Any

# scraper.py (and its gologin/selenium imports) is only importable on the VM.
# Import lazily in main() so `--help` works anywhere.

FB_ADLIB_BASE = "https://www.facebook.com/ads/library"

# Failure mitigation / pacing. All env-tunable so we can dial reliability vs
# speed without a redeploy.
FB_MAX_TRIES = int(os.environ.get("FB_PHASE1_MAX_TRIES", "3"))
FB_BLOCK_COOLDOWN_S = int(os.environ.get("FB_PHASE1_BLOCK_COOLDOWN_SECONDS", "12"))
# How many scroll cycles to attempt while loading the infinite results grid,
# and the settle delay between scrolls. Keep the scroll budget bounded so a
# sparse keyword doesn't spin forever.
FB_SCROLL_MAX_CYCLES = int(os.environ.get("FB_PHASE1_SCROLL_CYCLES", "30"))
FB_SCROLL_DELAY_S = int(os.environ.get("FB_PHASE1_SCROLL_DELAY_SECONDS", "3"))
# Cap the sampled ad copy we keep per advertiser (the scorer's keyword surface).
FB_AD_TEXT_SAMPLE_MAX = int(os.environ.get("FB_PHASE1_AD_TEXT_SAMPLE_MAX", "1500"))
# Cap landing links written per advertiser so a prolific Page doesn't flood fb_links.
FB_LINKS_PER_ADVERTISER_MAX = int(os.environ.get("FB_PHASE1_MAX_LINKS", "20"))


# ---------------------------------------------------------------------------
# Ad-card extraction
# ---------------------------------------------------------------------------

# Parse the rendered ad-card grid in the page. Returns one entry PER AD with
# its advertiser identity + a copy snippet; the Python side aggregates these
# up to Page rows. Done in one JS pass.
#
# Facebook's CSS class names are build-generated garbage (no stable hooks), so
# we anchor on the DURABLE signals instead:
#   - The advertiser link: every ad card carries a "See ad details" /
#     advertiser anchor whose href contains `view_all_page_id=<digits>` (the
#     "see all ads from this advertiser" link) — that digit run IS the page_id.
#     We also accept a plain facebook.com/<page> profile anchor as a fallback.
#   - The page_name: the visible text of that advertiser anchor.
#   - The ad copy: the card's text content, minus the boilerplate labels.
# These are best-effort until the live probe confirms them against real markup.
_ADCARD_JS = r"""
const out = [];

// Pull every (page_id, page_name, page_url) we can see, each tied to the
// nearest enclosing card so we can grab that card's ad copy.
function findCards(){
  const cards = new Map();   // node -> {page_id, page_name, page_url}
  // 1) Primary signal: anchors to "view_all_page_id=<digits>".
  for (const a of document.querySelectorAll('a[href*="view_all_page_id="]')) {
    const href = a.getAttribute('href') || a.href || '';
    const m = href.match(/view_all_page_id=(\d+)/);
    if (!m) continue;
    // climb to a reasonably-sized card container (cap the climb so we don't
    // grab the whole grid).
    let card = a, hops = 0;
    while (card.parentElement && hops < 8) {
      card = card.parentElement; hops++;
      const txt = (card.innerText || '');
      if (txt.length > 60) break;   // looks like a full card, not just a chip
    }
    if (!cards.has(card)) {
      cards.set(card, {
        page_id: m[1],
        page_name: (a.innerText || '').trim().slice(0, 200) || null,
        page_url: 'https://www.facebook.com/ads/library/?view_all_page_id=' + m[1],
      });
    }
  }
  // 2) Fallback signal: plain facebook.com/<vanity-or-id> profile anchors
  // inside the results region (only when no view_all_page_id was found). The
  // advertiser link is the page's profile URL — sometimes a vanity
  // (facebook.com/JamulCasinoResort), sometimes the numeric page id
  // (facebook.com/61572107082543), which IS the page_id we want for Phase 2.
  // FB system endpoints aren't advertiser pages and must be excluded, or the
  // outbound-link wrapper (l.php) gets mistaken for an advertiser.
  const SYS = /^(l\.php|sharer|dialog|tr|plugins|groups|watch|events|marketplace|gaming|ads|business|help|policies|login|privacy|profile\.php|permalink\.php|story\.php|photo\.php|reel|stories|hashtag|pages|public|legal|terms)$/i;
  for (const a of document.querySelectorAll('a[href*="facebook.com/"]')) {
    const href = a.getAttribute('href') || a.href || '';
    // FB wraps outbound ad links as l.facebook.com/l.php — never an advertiser.
    if (/l\.facebook\.com|\/l\.php/i.test(href)) continue;
    const m = href.match(/facebook\.com\/([A-Za-z0-9.\-]{2,})\/?(\?|$)/);
    if (!m) continue;
    const slug = m[1];
    if (SYS.test(slug)) continue;
    let card = a, hops = 0;
    while (card.parentElement && hops < 8) {
      card = card.parentElement; hops++;
      if ((card.innerText || '').length > 60) break;
    }
    if (!cards.has(card)) {
      // page name = first non-empty line of the anchor text, capped. If it
      // still looks like ad copy (very long, or carries a URL), drop it — the
      // anchor was an over-grab, not the advertiser name.
      let nm = ((a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0]) || null;
      if (nm && (nm.length > 100 || /https?:\/\//i.test(nm))) nm = null;
      // A purely-numeric slug (>=5 digits) is the page's numeric id.
      const pid = /^\d{5,}$/.test(slug) ? slug : null;
      // When we have the numeric page id, point page_url at the Ad Library
      // "see all ads from this advertiser" view (same as the primary signal
      // above) — not facebook.com/{id}, which is login-walled and shows "This
      // content isn't available" for these thin ad-only Pages. The advertiser's
      // gambling ads are visible in the Ad Library view even when the profile
      // isn't. Vanity-only slugs (no numeric id) keep the profile URL.
      cards.set(card, {
        page_id: pid,
        page_name: nm,
        page_url: pid
          ? 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=' + pid
          : 'https://www.facebook.com/' + slug,
      });
    }
  }
  return cards;
}

// Collect the outbound landing links carried by an ad card. FB wraps ad
// destinations as l.facebook.com/l.php?u=<encoded> (the unwrapped URL keeps the
// affiliate stag); the visible card text also shows the destination as an
// UPPERCASE display domain (IGAUSTRALIA.US, V6AUS.COM, HEYLINK.ME). We take
// both — hrefs first (they carry the stag), display domains as a fallback — so
// Phase 3 has casino landing links to score even though the per-page
// view_all_page_id view is unreliable on FB.
function cardLinks(card){
  const out = [];
  const seen = new Set();        // lowercased full urls (dedupe case variants)
  const seenHosts = new Set();   // hosts we already have a full url for
  function add(dest, isBareDomain){
    let host = '';
    try { host = new URL(dest).hostname.toLowerCase(); } catch (e) { return; }
    if (!host) return;
    if (/(^|\.)(facebook|fb|instagram|fbcdn|whatsapp|messenger)\.(com|me|net|gg)$/i.test(host)) return;
    if (/metastatus\.com$/i.test(host)) return;   // FB's own transparency footer link
    const key = dest.toLowerCase();
    if (seen.has(key)) return;
    // Skip a bare display-domain when we already captured a fuller URL for it.
    if (isBareDomain && seenHosts.has(host)) return;
    seen.add(key);
    seenHosts.add(host);
    out.push({ url: dest, source: 'ad_landing' });
  }
  // 1) anchors — unwrap l.php?u= (these carry the affiliate stag)
  for (const a of card.querySelectorAll('a[href]')) {
    let raw = a.getAttribute('href') || a.href || '';
    let dest = raw;
    try {
      const u = new URL(raw, location.origin);
      if (/l\.facebook\.com$/i.test(u.hostname) && u.searchParams.get('u')) {
        dest = decodeURIComponent(u.searchParams.get('u'));
      }
    } catch (e) {}
    if (/^https?:/i.test(dest)) add(dest, false);
  }
  const text = card.innerText || '';
  // 2) explicit http(s) URLs written in the ad copy
  const urlRe = /https?:\/\/[^\s)]+/gi;
  let m;
  while ((m = urlRe.exec(text))) add(m[0].replace(/[.,]+$/, ''), false);
  // 3) UPPERCASE display domains FB renders as the destination line (only kept
  //    when we don't already have a fuller URL for that host). Require the last
  //    segment to be a REAL TLD so dot-joined ad copy (WIN.BIG, PLAY.NOW,
  //    SPIN.PALACE) isn't synthesized into a fabricated landing link.
  const TLDS = new Set(['com','net','org','io','co','gg','vip','casino','bet','games','game','app','live','club','xyz','online','site','win','fun','bz','ag','cc','tv','me','to','ai','dev','link','life','world','biz','info','pro','us','uk','au','nz','ca','eu','de','fr','es','it','nl','se','no','dk','fi','ie','at','ch','be','pt','pl','cz','ro','br','mx','jp','in','za','sg','ph','id','my','th','vn','kr','ru','tr','ng','ke']);
  const domRe = /\b([A-Z0-9][A-Z0-9\-]*(?:\.[A-Z0-9\-]{2,})+)\b/g;
  let dm;
  while ((dm = domRe.exec(text))) {
    const dom = dm[1];
    const tld = dom.split('.').pop().toLowerCase();
    if (dom.length >= 4 && dom === dom.toUpperCase() && TLDS.has(tld)) {
      add('https://' + dom.toLowerCase(), true);
    }
  }
  return out.slice(0, 12);
}

for (const [card, info] of findCards()) {
  // Ad copy: the card's text minus the obvious UI boilerplate lines.
  let copy = (card.innerText || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^(Sponsored|Active|Inactive|Library ID|See ad details|See summary details|Open Drop-down|Started running on|Platforms|This ad has multiple versions)/i.test(s))
    .filter(s => s !== (info.page_name || ''))
    .join(' ')
    .slice(0, 600);
  out.push({
    page_id: info.page_id,
    page_name: info.page_name,
    page_url: info.page_url,
    ad_copy: copy || null,
    links: cardLinks(card),
  });
}
return out;
"""


def collect_ad_cards(driver, max_cycles: int) -> list[dict[str, Any]]:
    """Scroll the results grid, accumulating ad-card entries until the grid
    stops growing (two stale cycles) or the scroll budget is spent."""
    by_signature: dict[str, dict[str, Any]] = {}
    stale_cycles = 0
    for cycle in range(max_cycles):
        try:
            batch = driver.execute_script(_ADCARD_JS) or []
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] ad-card extraction crashed (cycle {cycle}): {exc}", file=sys.stderr)
            batch = []

        before = len(by_signature)
        for c in batch:
            # Dedupe individual ad cards by (page, copy) so re-reading the same
            # card across scrolls doesn't inflate the count. Distinct ads from
            # the same advertiser keep distinct signatures.
            sig = f"{c.get('page_id') or c.get('page_url')}|{(c.get('ad_copy') or '')[:80]}"
            if sig not in by_signature:
                by_signature[sig] = c
        gained = len(by_signature) - before

        if gained == 0:
            stale_cycles += 1
            if stale_cycles >= 2:
                break
        else:
            stale_cycles = 0

        try:
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:  # noqa: BLE001
            pass
        time.sleep(FB_SCROLL_DELAY_S)

    return list(by_signature.values())


def _aggregate_advertisers(ad_cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Roll per-ad cards up to one entry per advertiser Page: ad_count = number
    of that Page's ads we saw, ad_text_sample = its ad copy concatenated (capped)."""
    by_page: dict[str, dict[str, Any]] = {}
    for c in ad_cards:
        page_id = c.get("page_id")
        page_url = c.get("page_url")
        key = (page_id or page_url or "").strip()
        if not key:
            continue
        entry = by_page.get(key)
        if entry is None:
            entry = {
                "page_id": page_id,
                "page_name": c.get("page_name"),
                "page_url": page_url,
                "ad_count": 0,
                "_copy_parts": [],
                "_links": {},   # dest url -> source (dedupe across the Page's ads)
            }
            by_page[key] = entry
        entry["ad_count"] += 1
        if not entry.get("page_name") and c.get("page_name"):
            entry["page_name"] = c.get("page_name")
        copy = c.get("ad_copy")
        # Measure with the SAME separator the final sample uses (" · "), so the
        # accumulation cap matches the stored string's real length.
        if copy and len(" · ".join(entry["_copy_parts"])) < FB_AD_TEXT_SAMPLE_MAX:
            entry["_copy_parts"].append(copy)
        for l in c.get("links") or []:
            url = (l.get("url") or "").strip()
            if url and url not in entry["_links"]:
                entry["_links"][url] = l.get("source") or "ad_landing"

    advertisers: list[dict[str, Any]] = []
    for entry in by_page.values():
        sample_full = " · ".join(entry.pop("_copy_parts"))
        if len(sample_full) > FB_AD_TEXT_SAMPLE_MAX:
            cut = sample_full[:FB_AD_TEXT_SAMPLE_MAX]
            # Trim back to the last clean " · " boundary (or last space) so the
            # sample never ends mid-word / mid-URL.
            sep = cut.rfind(" · ")
            cut = cut[:sep] if sep > 0 else cut.rsplit(" ", 1)[0]
            sample_full = cut
        entry["ad_text_sample"] = sample_full or None
        entry["links"] = [
            {"url": u, "source": s} for u, s in list(entry.pop("_links").items())[:FB_LINKS_PER_ADVERTISER_MAX]
        ]
        advertisers.append(entry)
    return advertisers


def search_advertisers(driver, keyword: str, country_code: str, max_cycles: int) -> list[dict[str, Any]]:
    """Navigate the Ad Library keyword search for `keyword` and return the
    aggregated advertiser entries. country_code is required by the Ad Library
    (it scopes results by country); default upstream handles the fallback."""
    cc = (country_code or "ALL").upper()
    url = (
        f"{FB_ADLIB_BASE}/?active_status=active&ad_type=all&country={quote(cc)}"
        f"&q={quote(keyword)}&search_type=keyword_unordered&media_type=all"
    )
    driver.get(url)
    time.sleep(5)  # let the grid hydrate (FB is JS-heavy)
    cards = collect_ad_cards(driver, max_cycles)
    return _aggregate_advertisers(cards)


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def _advertiser_page_url(page_id: Any, cc: str, fallback: str) -> str:
    """Stored page_url for an advertiser. For a numeric page_id, return the
    canonical, COUNTRY-SCOPED Ad Library "see all ads from this advertiser" deep
    link — the form FB redirects to that actually renders the Page's ads. A bare
    facebook.com/{id} profile is login-walled (empty shell), and an Ad Library
    link scoped to country=ALL normalises to the "isn't running ads in the
    selected country" empty state for region-targeted (gambling) ads — both show
    BLANK, the "FB Ad Library appears blank for each result" QA report. We scope
    here at write time because the stored value is what Monday + external
    reviewers open, not just the in-app table (which re-scopes on render).
    Vanity-only Pages (no numeric id) keep their captured profile URL."""
    if page_id and str(page_id).isdigit():
        cc = (cc or "ALL").upper()
        return (
            f"{FB_ADLIB_BASE}/?active_status=all&ad_type=all"
            f"&country={quote(cc)}&view_all_page_id={page_id}"
            "&search_type=page&media_type=all"
        )
    return fallback


def _build_advertiser_payloads(
    job_id: str, keyword: str, country_code: str, advertisers: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Shape aggregated advertisers into (fb_advertisers row, [fb_links partials])
    tuples, aligned so the writer can attach links to each inserted Page id."""
    out: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for a in advertisers:
        page_url = (a.get("page_url") or "").strip()
        page_name = (a.get("page_name") or "").strip()
        if not page_url and not page_name:
            continue
        fallback = page_url or f"{FB_ADLIB_BASE}/?view_all_page_id={a.get('page_id')}"
        row = {
            "scrape_queue_id": job_id,
            "page_id": a.get("page_id"),
            "page_name": page_name or (a.get("page_id") or "Unknown advertiser"),
            "page_url": _advertiser_page_url(a.get("page_id"), country_code, fallback),
            "discovered_from_keyword": keyword,
            "ad_count": a.get("ad_count"),
            "ad_text_sample": a.get("ad_text_sample"),
        }
        out.append((row, a.get("links") or []))
    return out


def _build_rows(job_id: str, keyword: str, country_code: str, advertisers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """fb_advertisers rows only — used by --dry-run, which can't write the DB."""
    return [row for row, _ in _build_advertiser_payloads(job_id, keyword, country_code, advertisers)]


def write_advertisers_to_db(sb, job_id: str, keyword: str, country_code: str, advertisers: list[dict[str, Any]]) -> int:
    """Insert fb_advertisers, then the ad landing links into fb_links (keyed on
    each inserted advertiser's id — Supabase returns inserted rows in order)."""
    payloads = _build_advertiser_payloads(job_id, keyword, country_code, advertisers)
    if not payloads:
        return 0
    adv_rows = [row for row, _ in payloads]
    res = sb.table("fb_advertisers").insert(adv_rows).execute()
    inserted = res.data or []

    link_rows: list[dict[str, Any]] = []
    for (row, links), ret in zip(payloads, inserted):
        adv_id = ret.get("id")
        if not adv_id:
            continue
        for l in links:
            url = (l.get("url") or "").strip()
            if not url:
                continue
            link_rows.append({
                "fb_advertiser_id": adv_id,
                "url": url,
                "source": l.get("source") or "ad_landing",
            })
    if link_rows:
        sb.table("fb_links").insert(link_rows).execute()

    return len(adv_rows)


def _write_summary(output_path: str, keyword: str, language: str, total: int) -> None:
    """Summary JSON for worker.py → complete_scrape_job. Shape mirrors
    x_search.py / kick_search.py so the dispatch path stays uniform."""
    summary = {
        "params": {"keyword": keyword, "language": language},
        "total_results": total,
        "organic_results": total,
        "ppc_results": 0,
        "pages_scraped": 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": False,  # Ad Library Phase 1 runs logged-out
        "results": [],          # advertisers live in fb_advertisers, not this payload
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


# ---------------------------------------------------------------------------
# GoLogin lifecycle (mirrors x_search.py: defensive stop, bring-up retry loop,
# teardown on every exit path). No login gate — the Ad Library is public.
# ---------------------------------------------------------------------------

def run(args, scraper_mod) -> int:
    from gologin import GoLogin

    gologin_token = os.environ.get("GOLOGIN_API_TOKEN")
    if not gologin_token:
        print("[ERROR] GOLOGIN_API_TOKEN is not set", file=sys.stderr)
        return 1

    sb = None
    if args.mode == "search" and not args.dry_run:
        sb_url = os.environ.get("SUPABASE_URL")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not sb_url or not sb_key:
            print("[ERROR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
            return 1
        from supabase import create_client
        sb = create_client(sb_url, sb_key)

    keyword = args.query if args.mode == "probe" else args.keyword

    gl = GoLogin({"token": gologin_token, "profile_id": args.profile_id, "port": args.port})
    try:
        gl.stop()
    except Exception:
        pass
    time.sleep(3)

    driver = None
    session_ok = False
    for attempt in range(1, FB_MAX_TRIES + 1):
        try:
            print(f"[INFO] GoLogin session bring-up (attempt {attempt}/{FB_MAX_TRIES})")
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
            if attempt < FB_MAX_TRIES:
                time.sleep(FB_BLOCK_COOLDOWN_S)

    if not session_ok or driver is None:
        print("[ERROR] could not bring up a GoLogin session after retries", file=sys.stderr)
        try:
            gl.stop()
        except Exception:
            pass
        print("[RESULT] FAILED")
        return 2

    try:
        print(f"[INFO] Ad Library search | keyword={keyword!r} country={args.country_code or 'ALL'}")
        advertisers = search_advertisers(driver, keyword, args.country_code, FB_SCROLL_MAX_CYCLES)
        print(f"[INFO] aggregated {len(advertisers)} unique advertiser(s) from the ad grid")

        if args.mode == "probe":
            print("\n===== PROBE fb_adlibrary_search =====")
            print(json.dumps(advertisers, indent=2, default=str)[:8000])
            print("===== END PROBE =====\n")
            print("[RESULT] SUCCESS")
            return 0

        if args.dry_run:
            rows = _build_rows(args.job_id, keyword, args.country_code, advertisers)
            print(f"[DRY-RUN] would insert {len(rows)} rows into fb_advertisers.")
            if rows:
                print(json.dumps(rows[0], indent=2, default=str))
            _write_summary(args.output, keyword, args.language, len(rows))
            print(f"[DONE] Facebook | Total: {len(rows)} advertisers (dry-run, no DB write)")
            print("[RESULT] SUCCESS")
            return 0

        try:
            inserted = write_advertisers_to_db(sb, args.job_id, keyword, args.country_code, advertisers)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] Supabase insert into fb_advertisers failed: {exc}", file=sys.stderr)
            print("[RESULT] FAILED")
            return 3

        _write_summary(args.output, keyword, args.language, inserted)
        print(f"[DONE] Facebook | Total: {inserted} advertisers inserted into fb_advertisers")
        print("[RESULT] SUCCESS")
        return 0
    finally:
        _teardown(driver, gl)


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
    parser = argparse.ArgumentParser(description="Facebook Ad Library advertiser search → fb_advertisers (Phase 1)")
    parser.add_argument("profile_id", help="GoLogin profile ID (resi proxy; no login needed)")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (unique per worker)")
    parser.add_argument("--mode", choices=["search", "probe"], default="search",
                        help="'search' (default) writes fb_advertisers; 'probe' dumps parsed advertisers for --query, no DB")
    parser.add_argument("-k", "--keyword", default="", help="Keyword to search the Ad Library for")
    parser.add_argument("--query", default=None, help="(probe mode) keyword to search")
    parser.add_argument("-c", "--country", default="", help="Country display name (logged only)")
    parser.add_argument("--country-code", dest="country_code", default="", help="ISO-2 country code (scopes Ad Library results)")
    parser.add_argument("--language", default="en", help="2-letter language code (Phase 1: logged only)")
    parser.add_argument("--max-results", type=int, default=100, help="Soft cap (unused; scroll budget governs)")
    parser.add_argument("--job-id", dest="job_id", default=None, help="scrape_queue.id this run belongs to")
    parser.add_argument("--worker-id", dest="worker_id", default="", help="Worker identifier (logged)")
    parser.add_argument("--output", default="/tmp/fb_search.json", help="Summary JSON path")
    parser.add_argument("--interactive", action="store_true",
                        help="Park on noVNC if Facebook throws a checkpoint instead of failing")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the browser + parse but skip all DB writes")
    args = parser.parse_args()

    if args.mode == "probe" and not args.query:
        print("[ERROR] --mode probe requires --query", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)
    if args.mode == "search" and not args.keyword:
        print("[ERROR] --keyword is required in search mode", file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    try:
        import scraper as scraper_mod  # ~/scraper.py on the VM
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] could not import scraper.py (must run on a VM with selenium/gologin): {exc}",
              file=sys.stderr)
        print("[RESULT] FAILED")
        sys.exit(1)

    # Share captcha context with scraper.py's helpers (same mechanism as
    # x_search.py main()).
    scraper_mod._CAPTCHA_SOLVER_CTX["job_id"] = args.job_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_id"] = args.worker_id
    scraper_mod._CAPTCHA_SOLVER_CTX["worker_port"] = args.port
    scraper_mod._CAPTCHA_SOLVER_CTX["interactive"] = bool(args.interactive)
    scraper_mod._CAPTCHA_SOLVER_CTX["country_code"] = (args.country_code or "").strip().upper() or None

    rc = run(args, scraper_mod)
    sys.exit(rc)


if __name__ == "__main__":
    main()
