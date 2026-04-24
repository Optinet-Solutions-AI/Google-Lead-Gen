#!/usr/bin/env python3
import sys
import json
from datetime import datetime

log_file = "/tmp/openclaw_params_test.log"

with open(log_file, "a") as f:
    f.write("=" * 80 + "\n")
    f.write(f"Script executed at: {datetime.now().isoformat()}\n")
    f.write("=" * 80 + "\n")
    
    # Log all arguments
    f.write(f"\nTotal arguments: {len(sys.argv)}\n")
    f.write(f"sys.argv: {sys.argv}\n\n")
    
    # Log each argument separately
    for i, arg in enumerate(sys.argv):
        f.write(f"  arg[{i}]: {arg}\n")
    
    f.write("\n" + "=" * 80 + "\n\n")

# Print to stdout too
print("=" * 60)
print("PARAMETER TEST SCRIPT")
print("=" * 60)
print(f"Total arguments received: {len(sys.argv)}")
print(f"Arguments: {sys.argv}")
print(f"\nFull log written to: {log_file}")
print("=" * 60)

# Also try to parse as if they were proper arguments
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--keyword', type=str)
parser.add_argument('--country', type=str)
parser.add_argument('--pages', type=int)
parser.add_argument('--webhook', type=str)

try:
    args = parser.parse_args()
    print("\nParsed arguments:")
    print(f"  keyword: {args.keyword}")
    print(f"  country: {args.country}")
    print(f"  pages: {args.pages}")
    print(f"  webhook: {args.webhook}")
    
    with open(log_file, "a") as f:
        f.write("PARSED ARGUMENTS:\n")
        f.write(f"  keyword: {args.keyword}\n")
        f.write(f"  country: {args.country}\n")
        f.write(f"  pages: {args.pages}\n")
        f.write(f"  webhook: {args.webhook}\n")
        f.write("=" * 80 + "\n\n")
        
except Exception as e:
    print(f"\nFailed to parse arguments: {e}")
    with open(log_file, "a") as f:
        f.write(f"PARSE ERROR: {e}\n")
        f.write("=" * 80 + "\n\n")

print(f"\nCheck the log file: cat {log_file}")
