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

gl = GoLogin({
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2OTgzMTFiZDRlN2JmZWNkZDE3ZTc2YjQiLCJ0eXBlIjoiZGV2Iiwiand0aWQiOiI2OTgzMTMyY2VkOGI3NTY4YTk1NmU4YjIifQ.ATh8yvDYVeMn16tw71ILcfH6P3sa3G1rIerzD5YVNrk",
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
