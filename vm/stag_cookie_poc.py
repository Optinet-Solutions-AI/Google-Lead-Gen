#!/usr/bin/env python3
"""
[LGP-087] Cookie-based S-tag extraction POC.

Loads a candidate URL in a GoLogin+Chromium session, captures every
cookie the site drops, and compares against our current URL-param
extraction. The output is the raw material for deciding whether to
build a full cookie extractor in Sprint 2.

USAGE (on VM1 or VM2):
    python3 stag_cookie_poc.py \
        --input candidate_urls.txt \
        --output stag_cookie_poc_results.json

The candidate_urls.txt file should have one URL per line — the
current path expects the FINAL (post-redirect) affiliate landing
URL, not the tracker link.

WHAT WE MEASURE PER URL:
  1. Every cookie dropped (name, value, domain, path, httpOnly).
  2. Which cookies match one of the affiliate networks in the
     TypeScript catalog (lib/stag-extraction/networks.ts) — mirrored
     here as NETWORK_COOKIE_NAMES for use inside the VM.
  3. The URL-param extraction result on the SAME URL for comparison.
  4. Time to first cookie drop (measures whether we can shortcut the
     browser path with something lighter).

OUTPUT: JSON array, one object per URL, with fields:
  { url, final_url_after_settle, cookies:[{name,value,domain,path}],
    matched_networks:[{network,cookie_name,value}],
    url_param_extract:{param,value,network} | null,
    agreement: 'both'|'cookies_only'|'url_only'|'neither',
    ms_load, ms_first_cookie }

Compare-with-baseline notes at the bottom of this file after a run.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Networks catalog — mirrored subset of lib/stag-extraction/networks.ts
# ordered by expected recall so the first match wins.
NETWORK_COOKIE_NAMES = {
    'cellxpert':          {'cxd', 'cxd_offer_id', 'cxd_click_id', 'cellxpert_click', 'affid'},
    'income_access':      {'ias_partner', 'ias_part', 'iaid', 'iaclickid'},
    'myaffiliates':       {'ma_click_id', 'ma_visit', 'bta', 'btag_cookie'},
    'netrefer':           {'nrclickid', 'nr_pid', 'nr_bta'},
    'post_affiliate_pro': {'papvisitorid', 'papcookie_visit', 'a_aid'},
    'hasoffers':          {'aff_sub_id', 'hasoffers_aff', 'transaction_id'},
    'everflow':           {'ef_click', '_ef_click', 'ef_transaction_id'},
    'impact':             {'iradmc', '_impact_id', 'ir_click_id'},
    'commissionjunction': {'cje', 'cj_user', 'cjevent'},
    'rakuten':            {'ranmid', 'r_ranpid', 'ransiteid'},
    'kwanko':             {'kwanko_click', 'ktag'},
    'admitad':            {'aduid', '_asc'},
    'generic':            {'stag', 'affid', 'aff_id', 'affiliate_id'},
}
NETWORK_URL_PARAMS = {
    'cellxpert':          ['cxd', 'clickid'],
    'income_access':      ['iaid', 'aff', 'sub_aff', 'ia_partner'],
    'myaffiliates':       ['btag', 'bta', 'affiliate_id'],
    'netrefer':           ['btag', 'nrid', 'affid'],
    'post_affiliate_pro': ['a_aid', 'affiliateid', 'a_bid'],
    'hasoffers':          ['offer_id', 'aff_id', 'transaction_id', 'aff_sub'],
    'everflow':           ['ef_id', 'offer_id', 'transaction_id', 'oid'],
    'impact':             ['irclickid', 'clickid', 'sharedid'],
    'commissionjunction': ['pid', 'aid', 'sid'],
    'rakuten':            ['ranmid', 'raneaid', 'ransiteid'],
    'kwanko':             ['ns_source', 'ns_campaign', 'noc_aff'],
    'admitad':            ['admitad_uid', 'ad_id'],
    'generic':            ['stag', 'affid', 'mid', 'aff', 'ref', 'affiliate_id'],
}


def match_cookie(name: str):
    """Returns network_key or None. Case-insensitive."""
    lower = name.lower()
    for network, names in NETWORK_COOKIE_NAMES.items():
        if lower in names:
            return network
    return None


def extract_url_params(url: str):
    """Mirror of the current STAG_PARAM_ORDER-based extraction so we
    can compare apples-to-apples against the cookie path."""
    try:
        parsed = urlparse(url)
        q = parse_qs(parsed.query)
        for network, params in NETWORK_URL_PARAMS.items():
            for p in params:
                for key, values in q.items():
                    if key.lower() == p.lower() and values and values[0]:
                        return {'param': key, 'value': values[0], 'network': network}
    except Exception:
        return None
    return None


def run_chromium_capture(driver, url: str, settle_seconds: int = 3):
    """Loads the URL, waits settle_seconds, returns
    (final_url, cookies_list, ms_load, ms_first_cookie).
    Requires an existing Selenium WebDriver already attached to a
    GoLogin/Chromium session."""
    start = time.time()
    driver.get(url)
    load_ms = int((time.time() - start) * 1000)
    # Small poll loop to find the first cookie drop — some sites set
    # cookies before their JS finishes, others take a few seconds.
    first_cookie_ms = None
    for _ in range(settle_seconds * 4):
        cookies = driver.get_cookies()
        if cookies:
            if first_cookie_ms is None:
                first_cookie_ms = int((time.time() - start) * 1000)
            break
        time.sleep(0.25)
    # Wait full settle for late-drop cookies to land too.
    time.sleep(settle_seconds)
    cookies = driver.get_cookies()
    final_url = driver.current_url
    return final_url, cookies, load_ms, first_cookie_ms


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='one URL per line')
    parser.add_argument('--output', required=True, help='JSON path')
    parser.add_argument('--settle', type=int, default=3)
    parser.add_argument('--profile-id', help='Optional GoLogin profile id — if omitted, uses env DEFAULT_STAG_POC_PROFILE_ID')
    parser.add_argument('--headless', action='store_true')
    args = parser.parse_args()

    urls = [u.strip() for u in Path(args.input).read_text().splitlines() if u.strip() and not u.startswith('#')]
    print(f'[INFO] Processing {len(urls)} candidate URLs...')

    # Selenium + GoLogin bootstrap — copies the shape used in
    # vm/kick_profile_scrape.py / vm/x_profile_scrape.py so it works
    # on the existing VM setup.
    try:
        from gologin import GoLogin
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service
    except ImportError as exc:
        print(f'[ERROR] Missing selenium / gologin. Install first: {exc}', file=sys.stderr)
        sys.exit(1)

    import os
    profile_id = args.profile_id or os.environ.get('DEFAULT_STAG_POC_PROFILE_ID')
    if not profile_id:
        print('[ERROR] Pass --profile-id or set DEFAULT_STAG_POC_PROFILE_ID.', file=sys.stderr)
        sys.exit(1)
    token = os.environ.get('GOLOGIN_API_TOKEN')
    if not token:
        print('[ERROR] Set GOLOGIN_API_TOKEN in env (already set on VMs).', file=sys.stderr)
        sys.exit(1)
    port = int(os.environ.get('GOLOGIN_PORT', '9222'))

    gl = GoLogin({'token': token, 'profile_id': profile_id, 'port': port})
    debugger_address = gl.start()
    print(f'[INFO] GoLogin session at {debugger_address}')
    options = webdriver.ChromeOptions()
    options.add_experimental_option('debuggerAddress', debugger_address)
    driver = webdriver.Chrome(options=options)

    results = []
    try:
        for i, url in enumerate(urls, 1):
            print(f'[{i}/{len(urls)}] {url}', flush=True)
            # Wipe cookies between URLs so we measure per-URL drops
            # cleanly instead of cumulative.
            driver.delete_all_cookies()
            try:
                final_url, cookies, ms_load, ms_first_cookie = run_chromium_capture(
                    driver, url, settle_seconds=args.settle
                )
            except Exception as exc:  # noqa: BLE001
                print(f'  [WARN] load failed: {exc}', file=sys.stderr)
                results.append({'url': url, 'error': str(exc)})
                continue

            matched = []
            for c in cookies:
                network = match_cookie(c['name'])
                if network:
                    matched.append({'network': network, 'cookie_name': c['name'], 'value': c['value'][:200]})
            url_extract = extract_url_params(final_url)

            has_cookie = len(matched) > 0
            has_url = url_extract is not None
            if has_cookie and has_url:
                agreement = 'both'
            elif has_cookie:
                agreement = 'cookies_only'
            elif has_url:
                agreement = 'url_only'
            else:
                agreement = 'neither'

            results.append({
                'url': url,
                'final_url': final_url,
                'cookies': [{'name': c['name'], 'value_prefix': c['value'][:80], 'domain': c.get('domain'), 'path': c.get('path')} for c in cookies],
                'matched_networks': matched,
                'url_param_extract': url_extract,
                'agreement': agreement,
                'ms_load': ms_load,
                'ms_first_cookie': ms_first_cookie,
            })
            print(f'  cookies={len(cookies)} matched_networks={len(matched)} url_extract={"yes" if url_extract else "no"} agreement={agreement}')
    finally:
        driver.quit()
        try:
            gl.stop()
        except Exception:  # noqa: BLE001
            pass

    Path(args.output).write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f'\n[DONE] Wrote {len(results)} rows to {args.output}')

    total = len(results)
    both = sum(1 for r in results if r.get('agreement') == 'both')
    cookies_only = sum(1 for r in results if r.get('agreement') == 'cookies_only')
    url_only = sum(1 for r in results if r.get('agreement') == 'url_only')
    neither = sum(1 for r in results if r.get('agreement') == 'neither')
    errors = sum(1 for r in results if 'error' in r)
    print(f'\n=== POC SUMMARY ===')
    print(f'total processed:  {total}')
    print(f'  both agree:     {both}')
    print(f'  cookies only:   {cookies_only}   <-- COOKIE-WIN CASES')
    print(f'  url only:       {url_only}       <-- (would keep current pipeline for these)')
    print(f'  neither:        {neither}')
    print(f'  errors:         {errors}')


if __name__ == '__main__':
    main()
