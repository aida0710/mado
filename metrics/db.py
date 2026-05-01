"""Shared push client for metric collectors.

`push(host, command, output, category=...)` POSTs raw stdout to the
dashboard's `/api/external/metrics/push` endpoint. Reads `DASHBOARD_URL` and
`WRITE_TOKEN` from the environment (typically set per-cron-line on the
source host).

Standard library only — many target hosts have no `pip install`-able envs
and the standard image's Python may be 3.8.
"""
from __future__ import annotations

import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def push(
    host: str,
    command: str,
    output: str,
    *,
    category: str = "general",
    timeout: int = 30,
) -> None:
    """POST `output` to /api/external/metrics/push as text/plain.

    `category` is a free-text bucket used by the front-end to group cards
    into sections — e.g. "load", "ジョブ一覧", "node使用率".

    Exits the process with a non-zero status on configuration error or HTTP
    failure so cron's `MAILTO` surfaces the problem.
    """
    base = os.environ.get("DASHBOARD_URL")
    token = os.environ.get("WRITE_TOKEN")
    if not base or not token:
        sys.exit("DASHBOARD_URL and WRITE_TOKEN must be set in the environment")

    qs = urlencode({"host": host, "command": command, "category": category})
    url = f"{base.rstrip('/')}/api/external/metrics/push?{qs}"
    body = output.encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
        },
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            if resp.status >= 400:
                sys.exit(f"push failed: {resp.status} {resp.reason}")
    except HTTPError as e:
        sys.exit(f"push failed: HTTP {e.code} {e.reason}")
    except URLError as e:
        sys.exit(f"push failed: {e.reason}")
