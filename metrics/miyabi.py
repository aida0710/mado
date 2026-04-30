#!/usr/bin/env python3
"""Collect miyabi (東大) queue state via qstat and push to the dashboard.

Run from cron on a miyabi login node:

    */5 * * * * DASHBOARD_URL=http://dashboard.lan:3000 \
        WRITE_TOKEN=xxxxxxxx /home/me/web-dashboard/metrics/miyabi.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# Allow running this file directly without `python -m metrics.miyabi`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import push  # noqa: E402

HOST = "miyabi"
COMMAND = "qstat"
CATEGORY = "ジョブ一覧"
ARGV = ["qstat", "-a"]


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
