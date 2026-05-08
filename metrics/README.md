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
scp -r metrics you@example.host:~/mado/metrics/
```

`db.py` has no dependencies beyond Python 3.8+ stdlib.

## Run once

```sh
# prod: nginx が port 80 で公開 (デフォルト)
# dev:  vite dev server が port 5173 (http://mado.lan:5173)
DASHBOARD_URL=http://mado.lan \
WRITE_TOKEN=xxxxxxxx \
  python3 ~/mado/metrics/example.py
```

A successful push exits 0; failure exits non-zero with a message on
stderr (cron's `MAILTO` will pick it up).

## Schedule

In the target host's crontab:

```cron
*/5 * * * * DASHBOARD_URL=http://mado.lan WRITE_TOKEN=xxx /home/me/mado/metrics/example.py
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

ターゲットホストと用途で 2 通り使い分ける:

### A) 1 ホスト 1 コマンドの最小ケース → `example.py` をコピー

`example.py` を `df.py` 等にコピーして `HOST` / `COMMAND` / `CATEGORY` / `ARGV` を書き換える:

- `HOST = "example"`
- `COMMAND = "df"`
- `CATEGORY = "disk"`
- `ARGV = ["df", "-h", "/"]`

cron で 5 分間隔のような粒度で済むならこれが一番シンプル。出力前処理が要るなら `push(...)` の手前に書く。

### B) 1 ホストから複数コマンド / 細かい interval → `runner.py` + JSON config

`metrics/config/<host>.json` に複数コマンドと per-command interval を書き、`runner.py` を常駐させる。Miyabi (東大スパコン) のような HPC 監視向け。

サンプル (`metrics/config/miyabi.json`):

```json
{
  "host": "miyabi",
  "default_interval_seconds": 180,
  "commands": [
    {
      "category": "ノード使用率",
      "display_command": "pbsnodes -aSj",
      "argv": ["pbsnodes", "-aSj"]
    },
    {
      "category": "ジョブ一覧",
      "display_command": "qstat",
      "argv": ["qstat"]
    }
  ]
}
```

フィールド:

- `host` — ダッシュボードの host 名 (1 ファイル = 1 ホスト)
- `default_interval_seconds` (省略時 180) — 各コマンドの interval 既定値
- `default_timeout_seconds` (省略時 30) — 各コマンドのタイムアウト既定値
- `commands[].category` — フロントエンドのセクション見出し
- `commands[].display_command` — 表示用ラベル (ダッシュボードのカードに出る文字列)
- `commands[].argv` — 実行する引数配列 (`shell=False` で実行)。表示用と分離しているので長い引数列でも `display_command` だけ短くできる
- `commands[].interval_seconds` — このコマンド固有の interval (override)
- `commands[].timeout_seconds` — このコマンド固有のタイムアウト (override)

実行:

```sh
# 本番 (常駐ループ — デフォルト)
DASHBOARD_URL=http://mado.lan WRITE_TOKEN=xxx \
  python3 ~/mado/metrics/runner.py ~/mado/metrics/config/miyabi.json

# 単発実行 (cron / 手動テスト用)
python3 runner.py config/miyabi.json --once

# 特定コマンドだけ (デバッグ)
python3 runner.py config/miyabi.json --once --only "ノード使用率"
```

`--once` / `--loop` を省略すると `--loop` (常駐) がデフォルト。SIGTERM / Ctrl-C で graceful shutdown (現在実行中のコマンドが終わったら exit 0)。push 失敗は `--loop` ではログのみでループ継続、`--once` では非ゼロ exit (cron MAILTO で気付ける)。

### 動作確認

`--once` で全コマンドが想定通り push できることをまず確認:

```sh
DASHBOARD_URL=... WRITE_TOKEN=... python3 runner.py config/miyabi.json --once
```

ダッシュボードに各 category のカードが表示されれば OK。タイムアウトやコマンド未存在は "command timed out after Xs" / "command not found" として push されるので、ダッシュボードで気付ける。

### デプロイ

```sh
scp -r metrics you@miyabi:~/mado/metrics/
ssh you@miyabi 'nohup env DASHBOARD_URL=... WRITE_TOKEN=... \
  python3 ~/mado/metrics/runner.py ~/mado/metrics/config/miyabi.json \
  > ~/mado/metrics/runner.log 2>&1 &'
```

systemd / launchd ユニット化はまだ用意していない (運用してから必要性を判断)。

## Why Python and not bash

`api/cron-samples/push.sh` is the curl-based equivalent and works fine
for the common case. Python becomes worth it once a host needs more than
a single command (e.g., combine `uptime` + `df`), needs to parse output,
or needs richer error logging — all easier to write in 30 lines of
Python than in shell glue.
