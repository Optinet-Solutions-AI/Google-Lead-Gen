#!/usr/bin/env python3
import os
import time

# Set display to your VNC server
os.environ['DISPLAY'] = ':1'

import pyautogui

def press_ctrl_shift_o():
    """Press Ctrl+Shift+O key combination"""
    time.sleep(0.5)
    pyautogui.hotkey('ctrl', 'shift', 'o')
    print("Pressed Ctrl+Shift+O")

if __name__ == "__main__":
    press_ctrl_shift_o()
