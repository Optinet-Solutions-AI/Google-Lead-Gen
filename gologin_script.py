#!/usr/bin/env python3
import subprocess
import time
import os
import sys
import json
import argparse
from datetime import datetime

os.environ.setdefault('DISPLAY', ':1')
os.environ.setdefault('APPDIR', '/home/ubuntu/apps/squashfs-root')

os.environ['DISPLAY'] = ":1"

# COORDINATES
RUN_BTN_X = 321
RUN_BTN_Y = 205


def press_ctrl_shift_o():
    """Press Ctrl+Shift+O key combination"""
    time.sleep(0.5)
    try:
        import pyautogui
        pyautogui.hotkey('ctrl', 'shift', 'o')
        return True
    except Exception as e:
        return False


def click_at(x, y, label=""):
    subprocess.run(['xte', f'mousemove {x} {y}'])
    time.sleep(0.5)
    subprocess.run(['xte', 'mouseclick 1'])
    time.sleep(0.5)


def type_text(text):
    try:
        from pynput.keyboard import Controller
        keyboard = Controller()
        
        for char in text:
            keyboard.type(char)
            time.sleep(0.08)
        
        return True
    except Exception as e:
        print(f"  ERROR: {e}")
        return False


def take_screenshot(name):
    """Take a screenshot for debugging"""
    subprocess.run(['scrot', f'/tmp/{name}.png'], capture_output=True)


def move_window_to_origin():
    """Move GoLogin window to 0,0"""
    try:
        result = subprocess.run(['wmctrl', '-l'], capture_output=True, text=True)
        for line in result.stdout.split('\n'):
            if 'GoLogin' in line or 'gologin' in line:
                window_id = line.split()[0]
                subprocess.run(['wmctrl', '-i', '-r', window_id, '-e', '0,0,0,-1,-1'])
                time.sleep(1)
                return True
    except Exception as e:
        print(f"Could not move window: {e}")
    return False


def run_profile():
    """Click Run button to start browser profile"""
    
    move_window_to_origin()
    time.sleep(5)
    
    click_at(RUN_BTN_X, RUN_BTN_Y)
    
    for i in range(10, 0, -1):
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description='GoLogin Automation Script')
    args = parser.parse_args()
    
    start_time = datetime.now()
    
    try:
        # Step 1: Run the browser profile
        run_profile()
        
        time.sleep(5)
        
        # Step 2: Press Ctrl+Shift+O
        #if not press_ctrl_shift_o():
        #    error_msg = "Failed to press Ctrl+Shift+O"
        #    print(f"\n? {error_msg}")
        #    
        #    sys.exit(1)
        
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        
        print("SUCCESS")
        
        sys.exit(0)
        
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        print(f"\n? {error_msg}")
        
        sys.exit(1)


if __name__ == "__main__":
    main()
