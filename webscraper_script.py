import sys
import time
import json
import random
import argparse
import requests

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
def connect_to_gologin_browser(debugger_address="localhost:9222"):
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
# Google scraping
# ---------------------------
def get_google_results_selenium(driver, keyword, country, page=0, wait_for_sponsored=True):
    start = page * 10
    encoded_keyword = quote_plus(keyword)
    url = f"https://www.google.com/search?q={encoded_keyword}&start={start}"

    print(f"[INFO] Navigating to: {url}")
    driver.get(url)

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
def scrape_google_search(driver, keyword, country, max_pages=5, delay_min=2, delay_max=5):
    all_results = []

    for page in range(max_pages):
        page_results = get_google_results_selenium(driver, keyword, country, page)
        all_results.extend(page_results)

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
        "results": all_results
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
# Main
# ---------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Google scraper using existing GoLogin browser"
    )

    parser.add_argument("-k", "--keyword", required=True, help="Search keyword")
    parser.add_argument("-c", "--country", required=True, help="Country code (e.g., US, UK, AU)")
    parser.add_argument("--pages", type=int, default=10, help="Number of pages to scrape")
    parser.add_argument("--debugger", default="localhost:9222", help="Chrome debugger address")
    parser.add_argument("--webhook", default="https://automateoptinet.app.n8n.cloud/webhook/b166aa52-b779-407c-896b-8e1434aa2a93", help="Webhook URL")

    args = parser.parse_args()

    try:
        driver = connect_to_gologin_browser(args.debugger)

        data = scrape_google_search(
            driver,
            args.keyword,
            args.country,
            max_pages=args.pages
        )

        save_to_file(data)

        if args.webhook:
            send_to_webhook(data, args.webhook)

        print(
            f"[DONE] Total: {data['total_results']} | "
            f"Organic: {data['organic_results']} | "
            f"PPC: {data['ppc_results']}"
        )

    finally:
        if "driver" in locals():
            driver.quit()

if __name__ == "__main__":
    main()
