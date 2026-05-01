#!/usr/bin/env python3
"""Example metric collector: push `uptime` output to the dashboard.

Run from cron on any target host:

    */5 * * * * DASHBOARD_URL=http://dashboard.lan:3000 \
        WRITE_TOKEN=xxxxxxxx /home/me/web-dashboard/metrics/example.py

Copy and adapt this file (HOST / COMMAND / CATEGORY / ARGV) to add another
collector — e.g. `df.py` for `df -h /`, or `vmstat.py` for `vmstat 1 5`.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# Allow running this file directly without `python -m metrics.example`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import push  # noqa: E402

HOST = "example"
COMMAND = "uptime"
CATEGORY = "load"
ARGV = ["uptime"]


def main() -> int:
    proc = subprocess.run(
        ARGV,
        capture_output=True,
        text=True,
        check=False,
    )
    output = proc.stdout
    if proc.returncode != 0:
        # Push stderr alongside stdout so an operator sees what broke.
        output = (
            f"{output}\n--- stderr ---\n{proc.stderr}\n(exit {proc.returncode})\n"
        )
    push(HOST, COMMAND, output, category=CATEGORY)
    return 0


if __name__ == "__main__":
    sys.exit(main())
