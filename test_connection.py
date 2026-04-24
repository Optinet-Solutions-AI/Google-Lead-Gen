# test_connection.py
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
import time

chrome_options = webdriver.ChromeOptions()
chrome_options.add_experimental_option("debuggerAddress", "localhost:9222")
service = Service("/usr/local/bin/chromedriver")
driver = webdriver.Chrome(service=service, options=chrome_options)

print("Connected!")
print(f"Current URL: {driver.current_url}")

try:
    driver.get("https://www.google.com")
    print("Google loaded!")
    time.sleep(3)
    print(f"Title: {driver.title}")
except Exception as e:
    print(f"Failed: {e}")
