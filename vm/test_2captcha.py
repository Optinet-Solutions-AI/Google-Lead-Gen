#!/usr/bin/env python3
"""Standalone validator for the 2Captcha integration.

Runs OUTSIDE the scraper (no Selenium / GoLogin needed) so it works on a
worker VM or a laptop, as long as TWOCAPTCHA_API_KEY is in the env and
the network can reach 2captcha.com.

This mirrors the in.php / res.php client baked into vm/scraper.py
(_2captcha_submit / _2captcha_poll) so a green run here means the key,
the balance, and the request/poll round-trip are all good — leaving only
the in-page token injection (which needs a live wall) to verify on the VM.

Usage:
  # Cheap: just check the key is valid and has balance. No credits spent.
  TWOCAPTCHA_API_KEY=xxxx python3 test_2captcha.py

  # Full: also solve 2Captcha's official demo reCAPTCHA + Turnstile.
  # Spends a few credits. Proves the end-to-end submit→poll→token path.
  TWOCAPTCHA_API_KEY=xxxx python3 test_2captcha.py --live
"""

import os
import sys
import time
import argparse

import requests

API_KEY = os.environ.get("TWOCAPTCHA_API_KEY", "").strip()
IN_URL = "https://2captcha.com/in.php"
RES_URL = "https://2captcha.com/res.php"
POLL_SECONDS = 5
SOLVE_TIMEOUT_SECONDS = 130

# 2Captcha's own demo pages — public, stable sitekeys meant for exactly
# this kind of integration test. https://2captcha.com/demo
DEMO_RECAPTCHA = {
    "pageurl": "https://2captcha.com/demo/recaptcha-v2",
    "sitekey": "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u",
}
DEMO_TURNSTILE = {
    "pageurl": "https://2captcha.com/demo/cloudflare-turnstile",
    "sitekey": "0x4AAAAAAAVrOhxX2H7-XHCu",
}


def _ok(msg):
    print(f"  \033[32m✓\033[0m {msg}")


def _fail(msg):
    print(f"  \033[31m✗\033[0m {msg}")


def check_balance() -> bool:
    print("[1/N] Key + balance")
    if not API_KEY:
        _fail("TWOCAPTCHA_API_KEY is not set in the environment")
        return False
    try:
        resp = requests.get(
            RES_URL,
            params={"key": API_KEY, "action": "getbalance", "json": 1},
            timeout=30,
        )
        body = resp.json()
    except Exception as exc:  # noqa: BLE001
        _fail(f"balance request failed: {exc}")
        return False
    if body.get("status") == 1:
        bal = float(body["request"])
        _ok(f"key valid — balance ${bal:.3f}")
        if bal <= 0:
            _fail("balance is zero — live solves will fail with ERROR_ZERO_BALANCE")
            return False
        return True
    _fail(f"key rejected: {body.get('request')}")
    return False


def solve(kind: str, demo: dict) -> bool:
    print(f"[live] Solving demo {kind}")
    params = {"key": API_KEY, "json": 1, "pageurl": demo["pageurl"]}
    if kind == "recaptcha":
        params["method"] = "userrecaptcha"
        params["googlekey"] = demo["sitekey"]
    else:
        params["method"] = "turnstile"
        params["sitekey"] = demo["sitekey"]

    try:
        body = requests.post(IN_URL, data=params, timeout=30).json()
    except Exception as exc:  # noqa: BLE001
        _fail(f"submit failed: {exc}")
        return False
    if body.get("status") != 1:
        _fail(f"submit rejected: {body.get('request')}")
        return False
    request_id = str(body["request"])
    _ok(f"submitted (id={request_id}) — polling…")

    deadline = time.time() + SOLVE_TIMEOUT_SECONDS
    time.sleep(POLL_SECONDS)
    while time.time() < deadline:
        try:
            body = requests.get(
                RES_URL,
                params={"key": API_KEY, "action": "get", "id": request_id, "json": 1},
                timeout=30,
            ).json()
        except Exception as exc:  # noqa: BLE001
            print(f"    poll error: {exc}")
            time.sleep(POLL_SECONDS)
            continue
        if body.get("status") == 1:
            token = str(body["request"])
            _ok(f"token received ({len(token)} chars): {token[:40]}…")
            return True
        reason = body.get("request", "")
        if reason != "CAPCHA_NOT_READY":
            _fail(f"solve failed: {reason}")
            return False
        time.sleep(POLL_SECONDS)
    _fail(f"timed out after {SOLVE_TIMEOUT_SECONDS}s")
    return False


def main():
    parser = argparse.ArgumentParser(description="Validate the 2Captcha integration")
    parser.add_argument("--live", action="store_true",
                        help="Also solve the demo reCAPTCHA + Turnstile (spends credits)")
    args = parser.parse_args()

    print("=== 2Captcha integration check ===")
    results = [check_balance()]

    if args.live and results[0]:
        results.append(solve("recaptcha", DEMO_RECAPTCHA))
        results.append(solve("turnstile", DEMO_TURNSTILE))
    elif args.live:
        print("[live] skipped — balance check failed, fix that first")

    print("=== " + ("ALL PASSED" if all(results) else "FAILURES ABOVE") + " ===")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
