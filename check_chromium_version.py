import subprocess; print(subprocess.check_output(['snap', 'run', 'chromium', '--version']).decode().strip())
