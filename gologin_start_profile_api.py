from gologin import GoLogin
import os
import sys
import time

# Get profile_id from command line argument
if len(sys.argv) < 2:
    print("Error: Profile ID is required as a command line argument")
    print("Usage: python script.py <profile_id>")
    sys.exit(1)

profile_id = sys.argv[1]

gologin_token = os.environ.get("GOLOGIN_API_TOKEN")
if not gologin_token:
    print("Error: GOLOGIN_API_TOKEN is not set in the environment")
    sys.exit(1)

gl = GoLogin({
    "token": gologin_token,
    "profile_id": profile_id,
    "port": 9222,
})

try:
    debugger_address = gl.start()
    print("SUCCESS")
    # Give GoLogin a moment to fully spawn the browser
    time.sleep(2)
    # Force the Python process to exit cleanly
    sys.exit(0)
except Exception as e:
    print(f"Failed to start GoLogin profile. Error: {e}")
    sys.exit(1)
