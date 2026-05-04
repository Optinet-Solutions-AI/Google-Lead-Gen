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
# Wait for Sponsored Results to appear (max 7 seconds)
# ---------------------------
def wait_for_sponsored_results(driver, timeout=7):
    try:
        WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((By.XPATH, '//span[text()="Sponsored results"]'))
        )
        print("[DEBUG] Sponsored results section is now visible.")
    except:
        print("[INFO] Sponsored results section not found within timeout.")

# ---------------------------
# Extract Sponsored URLs using Selenium
# ---------------------------
def extract_sponsored_urls_selenium(driver):
    sponsored_urls = set()

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
                if url and url.startswith("http"):
                    sponsored_urls.add(url)
                    print(f"[DEBUG] Detected PPC URL: {url}")

        fallback_links = driver.find_elements(By.CSS_SELECTOR, 'a[data-pcu]')
        print(f"[DEBUG] Found {len(fallback_links)} fallback ad links.")
        for a in fallback_links:
            raw_url = a.get_attribute("data-pcu")
            url = raw_url.split(",")[0] if raw_url else None
            if url and url.startswith("http"):
                sponsored_urls.add(url)
                print(f"[DEBUG] Detected fallback PPC URL: {url}")

    except Exception as e:
        print(f"[WARN] PPC extraction failed: {e}", file=sys.stderr)

    print(f"[INFO] Detected {len(sponsored_urls)} PPC URLs")
    return sponsored_urls

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
def check_for_captcha(driver):
    """Detect if Google is showing a CAPTCHA or unusual traffic page"""
    current_url = driver.current_url
    if "/sorry/" in current_url or "captcha" in current_url.lower():
        raise CaptchaDetectedException("CAPTCHA detected in URL")
    try:
        page_source = driver.page_source.lower()
        if "unusual traffic" in page_source or "recaptcha" in page_source or "captcha" in page_source:
            raise CaptchaDetectedException("CAPTCHA detected in page source")
    except CaptchaDetectedException:
        raise
    except:
        pass

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

    sponsored_urls = extract_sponsored_urls_selenium(driver)

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

        # Extract base URL (scheme + netloc)
        parsed = urlparse(link)
        full_url = f"{parsed.scheme}://{parsed.netloc}"

        results.append({
            "url": link,
            "full_url": full_url,
            "title": h3.get_text(strip=True),
            "resultType": result_type,
            "page": page + 1,
            "position": position if result_type == "Organic" else None,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country
        })

        overall_position += 1
        if result_type == "Organic":
            position += 1

    # --- PPC results not included in organic ---
    for ppc_url in sponsored_urls:
        if any(r["url"] == ppc_url for r in results):
            continue
        a_tag = soup.find("a", href=ppc_url) or soup.find("a", {"data-pcu": ppc_url})
        title = a_tag.get_text(strip=True) if a_tag else ""

        # Extract base URL for PPC results
        parsed = urlparse(ppc_url)
        full_url = f"{parsed.scheme}://{parsed.netloc}"

        results.append({
            "url": ppc_url,
            "full_url": full_url,
            "title": title,
            "resultType": "PPC",
            "page": page + 1,
            "position": None,
            "overall_position": overall_position,
            "keyword": keyword,
            "country": country
        })
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
def scrape_google_search(driver, keyword, country, max_pages=5, delay_min=2, delay_max=5, language="en"):
    all_results = []
    login_state = None

    for page in range(max_pages):
        page_results = get_google_results_selenium(driver, keyword, country, page, language=language)
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
        "pages_scraped": max_pages,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "is_logged_in": login_state,
        "results": all_results
    }

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

    Bing pagination uses `&first=<offset>` where offset is 1, 11, 21, …
    """
    cc = BING_COUNTRY_TO_CC.get(country, "US")
    first = page * 10 + 1
    encoded_keyword = quote_plus(keyword)
    url = (
        f"https://www.bing.com/search?q={encoded_keyword}"
        f"&cc={cc}&setlang={language}&first={first}"
    )

    print(f"[INFO] Bing navigating to: {url}")
    driver.get(url)
    check_for_captcha(driver)

    # Step 1: dismiss the GDPR cookie banner. This is THE reason most
    # EU-region Bing scrapes were returning a single placeholder
    # result — b_results renders behind the consent modal, the parser
    # finds 1 vestigial block, returns. Click accept first.
    accept_bing_consent(driver)

    # Wait for the results container, then for the FIRST b_algo block
    # to materialize. Bing renders results progressively; grabbing
    # page_source immediately after b_results appears can land in
    # the middle of that paint.
    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.ID, "b_results"))
        )
    except Exception:
        print("[WARN] Bing results container not found")
        return []
    try:
        WebDriverWait(driver, 8).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "li.b_algo"))
        )
    except Exception:
        # Not fatal — some queries genuinely return zero organic.
        # Continue and let the parser see what's there.
        pass
    # Give the rest of the SERP time to settle (lazy-loaded blocks,
    # ad rendering, autosuggest panes shifting layout).
    time.sleep(2)

    page_source = driver.page_source
    _maybe_save_bing_debug(page_source, url)
    soup = BeautifulSoup(page_source, "html.parser")
    # Crude size sanity check — if the page is suspiciously small, we
    # probably hit a consent banner / interstitial / redirect rather
    # than a real SERP.
    if len(page_source) < 5000:
        print(f"[WARN] Bing page_source is only {len(page_source)} bytes — likely an interstitial")
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
    # up for some answer-style results. Iterate over all of them and
    # rely on _bing_first_http_anchor + seen_hrefs to dedupe.
    organic_blocks = soup.select(
        "li.b_algo, li.b_algo_group, li.b_algoSlug, "
        "ol#b_results > li.b_ans, "
        "li[data-bm]"
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
    parser.add_argument("--pages", type=int, default=10, help="Number of pages to scrape")
    parser.add_argument("--port", type=int, default=9222, help="Chrome debugger port (must be unique per concurrent worker)")
    parser.add_argument("--output", default="/tmp/google_results.json", help="Path to write the results JSON")
    parser.add_argument("--webhook", default=None, help="Optional webhook URL to POST results to (not used by the Supabase worker)")
    parser.add_argument("--language", default="en", help="Search language code (en, ar, de, …)")
    parser.add_argument("--engine", default="google", choices=["google", "bing"], help="Which search engine to scrape")

    args = parser.parse_args()

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
