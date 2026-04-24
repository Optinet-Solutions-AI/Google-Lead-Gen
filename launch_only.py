#!/usr/bin/env python3
import subprocess
import time
import os

os.environ['DISPLAY'] = ":1"

print("Setting up X11 access control...")
subprocess.run(['xhost', '+local:'], env={'DISPLAY': ':1'}, capture_output=True)

print("Killing existing GoLogin...")
subprocess.call(['pkill', '-9', '-f', 'gologin'])
time.sleep(2)

print("Launching GoLogin...")
process = subprocess.Popen(
    ["/home/ubuntu/apps/squashfs-root/AppRun", '--no-sandbox'],
    env={'DISPLAY': ':1', 'APPDIR': '/home/ubuntu/apps/squashfs-root'}
)

print(f"GoLogin started with PID: {process.pid}")
print("Waiting 15 seconds for it to load...")

for i in range(15, 0, -1):
    print(f"  {i} seconds remaining...")
    time.sleep(1)

result = subprocess.run(['pgrep', '-f', 'gologin'], capture_output=True, text=True)

if result.stdout:
    print("\n? SUCCESS! GoLogin is running!")
    print("Check your VNC viewer - GoLogin should be visible")
    print(f"Process IDs: {result.stdout.strip()}")
else:
    print("\n? FAILED - GoLogin is not running")

print("\nDone!")
