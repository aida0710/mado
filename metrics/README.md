# Metric collectors

Per-host Python scripts that run on a target machine (via cron), capture
the relevant command output, and push it to the dashboard's
`/api/external/metrics/push` endpoint.

```
metrics/
├── db.py        # shared HTTP push helper, stdlib only
├── example.py   # example: uptime
└── ...          # add df.py, vmstat.py, etc. on the same shape
```

## Deploy

Copy the directory to the target host's user account:

```sh
scp -r metrics you@example.host:~/web-dashboard/metrics/
```

`db.py` has no dependencies beyond Python 3.8+ stdlib.

## Run once

```sh
# prod: nginx が port 80 で公開 (デフォルト)
# dev:  vite dev server が port 5173 (http://dashboard.lan:5173)
DASHBOARD_URL=http://dashboard.lan \
WRITE_TOKEN=xxxxxxxx \
  python3 ~/web-dashboard/metrics/example.py
```

A successful push exits 0; failure exits non-zero with a message on
stderr (cron's `MAILTO` will pick it up).

## Schedule

In the target host's crontab:

```cron
*/5 * * * * DASHBOARD_URL=http://dashboard.lan WRITE_TOKEN=xxx /home/me/web-dashboard/metrics/example.py
```

## Categories

`db.push` accepts a free-text `category` keyword (default `"general"`)
that the front-end uses to group cards into sections. Pick whatever you
want — the dashboard reflects it as a section header.

```python
from db import push
push("example", "uptime", out, category="load")
push("example", "df",     out, category="disk")
push("example", "tokens", out, category="トークン数")
```

The dashboard only displays metrics pushed in the **last 1 hour**, so a
silent cron disappears from the UI rather than displaying stale numbers.

## Adding a new host or command

Copy `example.py` to e.g. `df.py` and adjust:

- `HOST = "example"`
- `COMMAND = "df"`
- `CATEGORY = "disk"`
- `ARGV = ["df", "-h", "/"]`

The file remains a thin wrapper around `db.push`. If output preprocessing
is ever needed (formatting, header trimming), do it inline before the
`push(...)` call — `db.push` only deals with the HTTP wire format.

For multiple metrics from one host, write multiple scripts (e.g.
`example-load.py`, `example-disk.py`) or a single script that calls
`push()` several times with different categories.

## Why Python and not bash

`api/cron-samples/push.sh` is the curl-based equivalent and works fine
for the common case. Python becomes worth it once a host needs more than
a single command (e.g., combine `uptime` + `df`), needs to parse output,
or needs richer error logging — all easier to write in 30 lines of
Python than in shell glue.
