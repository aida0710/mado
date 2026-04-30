# HPC metric collectors

Per-HPC Python scripts that run on each login node (via cron), capture
the relevant queue/state command, and push it to the dashboard's
`/api/hpc/push` endpoint.

```
metrics/
├── db.py        # shared HTTP push helper, stdlib only
├── miyabi.py    # 東大 miyabi: qstat -a
└── ...          # add osaka.py, fugaku.py, etc. on the same shape
```

## Deploy

Copy the directory to the HPC user account:

```sh
scp -r metrics you@miyabi.example:~/web-dashboard/metrics/
```

`db.py` has no dependencies beyond Python 3.8+ stdlib.

## Run once

```sh
DASHBOARD_URL=http://dashboard.lan:3000 \
WRITE_TOKEN=xxxxxxxx \
  python3 ~/web-dashboard/metrics/miyabi.py
```

A successful push exits 0; failure exits non-zero with a message on
stderr (cron's `MAILTO` will pick it up).

## Schedule

In the HPC user's crontab:

```cron
*/5 * * * * DASHBOARD_URL=http://dashboard.lan:3000 WRITE_TOKEN=xxx /home/me/web-dashboard/metrics/miyabi.py
```

## Categories

`db.push` accepts a free-text `category` keyword (default `"general"`)
that the front-end uses to group cards into sections. Pick whatever you
want — the dashboard reflects it as a section header.

```python
from db import push
push("miyabi", "qstat", out, category="ジョブ一覧")
push("miyabi", "df",    out, category="node使用率")
push("miyabi", "tokens", out, category="トークン数")
```

The dashboard only displays metrics pushed in the **last 1 hour**, so a
silent cron disappears from the UI rather than displaying stale numbers.

## Adding a new HPC

Copy `miyabi.py` to e.g. `osaka.py` and adjust:

- `HOST = "osaka"`
- `COMMAND = "pjstat"` (or whatever the scheduler's command is)
- `CATEGORY = "ジョブ一覧"` (or whatever bucket fits)
- `ARGV = ["pjstat", "-A"]`

The file remains a thin wrapper around `db.push`. If output preprocessing
is ever needed (formatting, header trimming), do it inline before the
`push(...)` call — `db.push` only deals with the HTTP wire format.

For multiple metrics from one host, write multiple scripts (e.g.
`miyabi-jobs.py`, `miyabi-tokens.py`) or a single script that calls
`push()` several times with different categories.

## Why Python and not bash

`api/cron-samples/push.sh` is the curl-based equivalent and works fine
for the common case. Python becomes worth it once a host needs more than
a single command (e.g., combine `qstat` + `df`), needs to parse output,
or needs richer error logging — all easier to write in 30 lines of
Python than in shell glue.
