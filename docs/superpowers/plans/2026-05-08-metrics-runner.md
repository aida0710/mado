# Metrics ランナー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Config 駆動の常駐メトリクスランナー (`metrics/runner.py`) を追加し、複数コマンドを per-command interval でダッシュボードに push できるようにする。

**Architecture:** 単一の Python ファイル (`runner.py`) が JSON config を読み込み、各コマンドを `subprocess.run` で直列実行して既存の `db.push()` で送る。`--once` (一発実行 / cron / デバッグ用) と `--loop` (常駐、デフォルト) の 2 モード。`time.monotonic()` ベースの per-command `next_run_at` 辞書で interval を管理する。

**Tech Stack:** Python 3.8+ stdlib のみ (`json` / `argparse` / `subprocess` / `time` / `signal` / `dataclasses` / `urllib`)。ターゲットホスト (Miyabi 等) は `pip install` 不可のため stdlib 縛り。既存の `metrics/db.py` を再利用。

**Spec:** `docs/superpowers/specs/2026-05-08-metrics-runner-design.md`

---

## File Structure

| ファイル | 状態 | 責務 |
|---------|------|------|
| `metrics/runner.py` | **新規** | CLI + config 読み込み + コマンド実行 + ループスケジューリング + シグナル処理。すべて 1 ファイルに集約。 |
| `metrics/config/miyabi.json` | **新規** | Miyabi 用初期サンプル config (`pbsnodes -aSj` と `qstat`)。 |
| `metrics/README.md` | **更新** | "Adding a new host or command" セクションに runner の使い方を追記。 |
| `metrics/db.py` | 変更なし | 既存 `push()` をそのまま使う。 |
| `metrics/example.py` | 変更なし | 1 ホスト 1 コマンドの最小例として残す。 |

**なぜ 1 ファイルか:** stdlib only 制約、`example.py` の流儀と整合、scp デプロイの単純さ、規模 (~200 LOC)。複数ファイルに分けるメリットは規模的に薄い。

## Verification 方針

spec で「自動テストは追加しない」と決めたため、各タスク末に **手動検証コマンド** を置く。具体的には:

- **Pure な関数 (config loading, 出力フォーマット)** → `python3 -c "..."` で直接呼んで結果を目視。
- **push を含む経路** → 同マシン上にローカル HTTP サーバ (`python3 -m http.server` ベース) を立て、push が届くのを確認。
- **一時 config** は `/tmp/metrics-test-*.json` に置きリポジトリを汚さない。

各タスクの verify ステップに具体コマンドと期待出力を記載する。

---

## Task 1: Config 型と loading

**Files:**
- Create: `metrics/runner.py`

`@dataclass` で `Command` / `Config` を定義し、`load_config(path)` で JSON → Config に変換する。型不正・必須欠落は `ValueError` で早期に落とす。

- [ ] **Step 1: `metrics/runner.py` を新規作成**

```python
#!/usr/bin/env python3
"""Config 駆動のメトリクスランナー (常駐 / 単発両対応)。

詳細仕様は docs/superpowers/specs/2026-05-08-metrics-runner-design.md を参照。
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

# `python -m metrics.runner` を使わず直接実行できるよう example.py と同じ手法。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import push  # noqa: E402


@dataclass(frozen=True)
class Command:
    category: str
    command: str
    argv: List[str]
    interval_seconds: float
    timeout_seconds: float


@dataclass(frozen=True)
class Config:
    host: str
    commands: List[Command]


def load_config(path: Path) -> Config:
    """JSON config を読み Config / Command にする。

    型不正・必須欠落は ValueError で早期に落とす (運用時の謎挙動を避ける)。
    """
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: top-level must be an object")

    host = raw.get("host")
    if not isinstance(host, str) or not host:
        raise ValueError(f"{path}: 'host' must be a non-empty string")

    default_interval = float(raw.get("default_interval_seconds", 180))
    default_timeout = float(raw.get("default_timeout_seconds", 30))

    commands_raw = raw.get("commands")
    if not isinstance(commands_raw, list) or not commands_raw:
        raise ValueError(f"{path}: 'commands' must be a non-empty array")

    commands: List[Command] = []
    for i, c in enumerate(commands_raw):
        if not isinstance(c, dict):
            raise ValueError(f"{path}: commands[{i}] must be an object")
        for key in ("category", "command", "argv"):
            if key not in c:
                raise ValueError(f"{path}: commands[{i}] missing '{key}'")
        if not isinstance(c["argv"], list) or not c["argv"]:
            raise ValueError(
                f"{path}: commands[{i}].argv must be a non-empty array"
            )
        commands.append(Command(
            category=str(c["category"]),
            command=str(c["command"]),
            argv=[str(x) for x in c["argv"]],
            interval_seconds=float(c.get("interval_seconds", default_interval)),
            timeout_seconds=float(c.get("timeout_seconds", default_timeout)),
        ))

    return Config(host=host, commands=commands)
```

- [ ] **Step 2: 実行権限を付ける**

```bash
chmod +x /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py
```

- [ ] **Step 3: 正常系の検証 (一時 config を読む)**

```bash
cat > /tmp/metrics-test-ok.json <<'JSON'
{
  "host": "test",
  "default_interval_seconds": 60,
  "commands": [
    {"category": "load", "command": "uptime", "argv": ["uptime"]},
    {"category": "disk", "command": "df", "argv": ["df", "-h"], "interval_seconds": 300}
  ]
}
JSON

cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import load_config
from pathlib import Path
c = load_config(Path('/tmp/metrics-test-ok.json'))
print('host:', c.host)
for cmd in c.commands:
    print(f'  {cmd.command} interval={cmd.interval_seconds}s timeout={cmd.timeout_seconds}s')
"
```

期待出力:
```
host: test
  uptime interval=60.0s timeout=30.0s
  df interval=300.0s timeout=30.0s
```

- [ ] **Step 4: 異常系の検証 (host 欠落)**

```bash
echo '{"commands": []}' > /tmp/metrics-test-bad.json
cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import load_config
from pathlib import Path
try:
    load_config(Path('/tmp/metrics-test-bad.json'))
except ValueError as e:
    print('OK got ValueError:', e)
"
```

期待出力 (どちらかのエラーが先に出れば OK):
```
OK got ValueError: /tmp/metrics-test-bad.json: 'host' must be a non-empty string
```

- [ ] **Step 5: Commit**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git add metrics/runner.py
git commit -m "feat(metrics): runner.py のスケルトンと config ローダー

@dataclass で Command/Config を定義し、JSON から型チェック付きで
読み込む load_config() を追加。db.push の import パス設定は
example.py と同じ手法を踏襲。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 単一コマンド実行 (`_run_subprocess`)

**Files:**
- Modify: `metrics/runner.py` (関数追加)

`subprocess.run` を呼んで「成功 / exit≠0 / timeout / FileNotFoundError」のすべてのケースで push 用の output 文字列を返すユーティリティを作る。push 自体はまだ呼ばない (Task 3 で繋ぐ)。

- [ ] **Step 1: `_run_subprocess` を `runner.py` に追加**

`load_config` の下に以下を追記。

```python
import subprocess  # ファイル先頭の import 群に追加


def _run_subprocess(cmd: Command) -> str:
    """argv を実行し、push 用の output 文字列を返す。

    成功/失敗/タイムアウト/コマンド未存在のいずれもサイレント断にせず、
    人間が読める形で文字列に詰める (ダッシュボードに表示される)。
    """
    try:
        proc = subprocess.run(
            cmd.argv,
            capture_output=True,
            text=True,
            timeout=cmd.timeout_seconds,
            check=False,
        )
        output = proc.stdout
        if proc.returncode != 0:
            output = (
                f"{output}\n--- stderr ---\n{proc.stderr}\n"
                f"(exit {proc.returncode})\n"
            )
        return output
    except subprocess.TimeoutExpired as e:
        partial = e.stdout or ""
        return (
            f"{partial}\n--- timeout ---\n"
            f"command timed out after {cmd.timeout_seconds}s\n"
        )
    except FileNotFoundError:
        return f"--- error ---\ncommand not found: {cmd.argv[0]}\n"
```

ファイル先頭の `import` 群を以下に更新:

```python
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional
```

- [ ] **Step 2: 成功ケースの検証 (echo)**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import _run_subprocess, Command
c = Command(category='t', command='echo', argv=['echo', 'hello'],
            interval_seconds=1.0, timeout_seconds=5.0)
print(repr(_run_subprocess(c)))
"
```

期待出力:
```
'hello\n'
```

- [ ] **Step 3: exit≠0 ケースの検証 (false)**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import _run_subprocess, Command
c = Command(category='t', command='false', argv=['false'],
            interval_seconds=1.0, timeout_seconds=5.0)
print(_run_subprocess(c))
"
```

期待出力:
```

--- stderr ---

(exit 1)

```

- [ ] **Step 4: timeout ケースの検証**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import _run_subprocess, Command
c = Command(category='t', command='sleep', argv=['sleep', '5'],
            interval_seconds=1.0, timeout_seconds=1.0)
print(_run_subprocess(c))
"
```

期待出力 (約 1 秒待ってから):
```

--- timeout ---
command timed out after 1.0s

```

- [ ] **Step 5: FileNotFoundError ケースの検証**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import _run_subprocess, Command
c = Command(category='t', command='nope', argv=['nonexistent_cmd_xyz'],
            interval_seconds=1.0, timeout_seconds=1.0)
print(_run_subprocess(c))
"
```

期待出力:
```
--- error ---
command not found: nonexistent_cmd_xyz

```

- [ ] **Step 6: Commit**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git add metrics/runner.py
git commit -m "feat(metrics): _run_subprocess で 4 ケース全部を文字列化

成功/exit≠0/timeout/FileNotFoundError のすべてを human-readable
な output 文字列にして返す。push 呼び出しはまだ繋がない。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: CLI + `--once` モード + `--only` フィルタ

**Files:**
- Modify: `metrics/runner.py` (`run_once`, `main`, タイムスタンプヘルパ追加)

argparse で CLI を組み、`--once` モードで全コマンド (or `--only` にマッチするもの) を 1 回ずつ実行 → push する。`--loop` モードは Task 4 で繋ぐので、今は `NotImplementedError` で落とす。

- [ ] **Step 1: ヘルパとモード関数を追加**

`runner.py` の import 群に追加:

```python
import argparse
import time
from datetime import datetime
```

`_run_subprocess` の下に以下を追加:

```python
def _ts() -> str:
    """ローカル TZ の ISO8601 タイムスタンプ (秒精度)。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def run_once(config: Config, only: Optional[str] = None) -> int:
    """全コマンド (or only に一致するもの) を 1 回ずつ実行 → push。

    Returns: 0 on full success, 1 if any command's push failed
             (cron MAILTO で気付けるよう非ゼロを返す)。

    `only` は category または command の完全一致 (大文字小文字も区別)。
    """
    rc = 0
    matched = 0
    for cmd in config.commands:
        if only is not None and only != cmd.category and only != cmd.command:
            continue
        matched += 1
        started = time.monotonic()
        output = _run_subprocess(cmd)
        try:
            push(config.host, cmd.command, output, category=cmd.category)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            print(f"[{_ts()}] {cmd.command} → push ok ({elapsed_ms}ms)",
                  flush=True)
        except SystemExit as e:
            print(f"[{_ts()}] {cmd.command} → push FAILED: {e}",
                  flush=True, file=sys.stderr)
            rc = 1
    if only is not None and matched == 0:
        print(f"[{_ts()}] no commands matched --only {only!r}",
              file=sys.stderr)
        rc = 1
    return rc


def main() -> int:
    p = argparse.ArgumentParser(description="Config-driven metrics runner.")
    p.add_argument("config", type=Path, help="path to config JSON")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true",
                      help="run all commands once and exit")
    mode.add_argument("--loop", action="store_true",
                      help="run continuously (default if neither flag given)")
    p.add_argument("--only",
                   help="run only commands whose category OR command "
                        "exactly equals this string")
    args = p.parse_args()

    cfg = load_config(args.config)

    if args.once:
        return run_once(cfg, only=args.only)
    # default = --loop
    raise NotImplementedError("--loop is wired in Task 4")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: ローカル fake HTTP サーバを起動 (バックグラウンド)**

別ターミナルで使う形ではなく、ワンライナーでバックグラウンド起動 → 検証 → kill する。サーバは POST 受信内容を stdout に出すだけ。

```bash
python3 - <<'PY' > /tmp/metrics-fake-server.log 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8", "replace")
        print(f"POST {self.path}", flush=True)
        print(f"  body: {body[:200]!r}", flush=True)
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8765), H).serve_forever()
PY
echo "fake server PID=$!" > /tmp/metrics-fake-pid
sleep 0.3
```

PID 控え:
```bash
cat /tmp/metrics-fake-pid
```

- [ ] **Step 3: `--once` で全コマンド実行を検証**

```bash
DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-ok.json --once

echo "--- server log ---"
cat /tmp/metrics-fake-server.log
```

期待出力 (runner 側):
```
[2026-05-08T...] uptime → push ok (NNms)
[2026-05-08T...] df → push ok (NNms)
```

期待出力 (server log):
```
POST /api/external/metrics/push?host=test&command=uptime&category=load
  body: '... uptime output ...'
POST /api/external/metrics/push?host=test&command=df&category=disk
  body: '... df output ...'
```

- [ ] **Step 4: `--once --only "load"` で 1 つだけ実行を検証**

```bash
> /tmp/metrics-fake-server.log  # ログをクリア

DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-ok.json --once --only "load"

echo "--- server log ---"
cat /tmp/metrics-fake-server.log
```

期待出力 (runner): `uptime → push ok` の 1 行のみ (df は出ない)。
期待出力 (server log): POST が 1 件のみ (uptime のもの)。

- [ ] **Step 5: `--only` 不一致時のエラーを検証**

```bash
DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-ok.json --once --only "nope" ; \
  echo "exit=$?"
```

期待: `no commands matched --only 'nope'` が stderr に出て `exit=1`。

- [ ] **Step 6: `--loop` が NotImplementedError で落ちることを検証 (Task 4 まで暫定)**

```bash
DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-ok.json --loop 2>&1 | tail -1
```

期待: `NotImplementedError: --loop is wired in Task 4`。

- [ ] **Step 7: fake server を停止**

```bash
kill $(grep -oE '[0-9]+' /tmp/metrics-fake-pid) 2>/dev/null
rm -f /tmp/metrics-fake-pid /tmp/metrics-fake-server.log
```

- [ ] **Step 8: Commit**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git add metrics/runner.py
git commit -m "feat(metrics): CLI と --once / --only モード

argparse で config パスと --once/--loop/--only を受け、--once で
全コマンドを 1 回ずつ push する。--loop は Task 4 で繋ぐ。
db.push の SystemExit を catch して非ゼロ exit に集約 (cron 連携用)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `--loop` モード (per-command interval スケジューリング)

**Files:**
- Modify: `metrics/runner.py` (`run_loop` 追加、`main` の NotImplementedError を置換)

`time.monotonic()` ベースの `next_run_at` 辞書で per-command interval を管理する。push 失敗 (SystemExit) は catch してログだけ出してループ継続 — daemon が一時的な NW 不調で死ぬのを避けるため。

- [ ] **Step 1: `run_loop` を `runner.py` に追加**

`run_once` の下に追加:

```python
def run_loop(config: Config) -> int:
    """常駐ループ。各コマンドは独立した next_run_at で due になったら実行。

    push 失敗 (SystemExit) は catch して継続 — 一時的 NW 不調で daemon を
    死なせないため。FATAL なエラー (config 不正など) は load_config 段階で
    既に弾かれているはずなので、ここではループ継続を優先する。
    """
    n = len(config.commands)
    next_run_at: List[float] = [0.0] * n  # 初回は即座に全部走る (now=0 > 0 は False だが下の判定で <= 0 にすれば走る)

    print(f"[{_ts()}] starting loop: {n} commands, host={config.host}",
          flush=True)

    while True:
        now = time.monotonic()
        for i, cmd in enumerate(config.commands):
            if next_run_at[i] <= now:
                started = time.monotonic()
                output = _run_subprocess(cmd)
                try:
                    push(config.host, cmd.command, output, category=cmd.category)
                    elapsed_ms = int((time.monotonic() - started) * 1000)
                    print(f"[{_ts()}] {cmd.command} → push ok ({elapsed_ms}ms)",
                          flush=True)
                except SystemExit as e:
                    print(f"[{_ts()}] {cmd.command} → push FAILED: {e}",
                          flush=True, file=sys.stderr)
                next_run_at[i] = time.monotonic() + cmd.interval_seconds

        sleep_for = max(1.0, min(next_run_at) - time.monotonic())
        time.sleep(sleep_for)
```

`main()` の NotImplementedError 行を置換:

```python
    if args.once:
        return run_once(cfg, only=args.only)
    return run_loop(cfg)
```

- [ ] **Step 2: 短い interval でループを検証する用の config を作成**

```bash
cat > /tmp/metrics-test-loop.json <<'JSON'
{
  "host": "loop-test",
  "default_interval_seconds": 3,
  "commands": [
    {"category": "fast", "command": "echo-fast", "argv": ["echo", "fast"]},
    {"category": "slow", "command": "echo-slow", "argv": ["echo", "slow"], "interval_seconds": 7}
  ]
}
JSON
```

- [ ] **Step 3: fake サーバを起動**

(Task 3 と同じ。サーバが既に動いていない確認の上で再起動)

```bash
pkill -f "BaseHTTPRequestHandler" 2>/dev/null ; sleep 0.2

python3 - <<'PY' > /tmp/metrics-fake-server.log 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        # 受信時刻と URL のクエリを記録
        from datetime import datetime
        print(f"{datetime.now().strftime('%H:%M:%S')} POST {self.path}",
              flush=True)
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8765), H).serve_forever()
PY
echo "fake server PID=$!" > /tmp/metrics-fake-pid
sleep 0.3
```

- [ ] **Step 4: 12 秒間ループを回して timing を確認**

`echo-fast` は 3s ごと、`echo-slow` は 7s ごとに push されるはず。12 秒回せば fast が ~5 回、slow が ~2 回見える。

```bash
DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  timeout 12 python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-loop.json --loop ; \
  echo "(timeout exited as expected)"

echo "--- server log ---"
cat /tmp/metrics-fake-server.log
```

期待: server log で `command=echo-fast` の行が ~5 個、`command=echo-slow` の行が ~2 個。タイムスタンプ間隔が概ね 3s と 7s。

- [ ] **Step 5: push 失敗時もループ継続することを検証**

サーバを止めた状態で 8 秒回し、push FAILED が複数出てもプロセスが死なないことを確認。

```bash
kill $(grep -oE '[0-9]+' /tmp/metrics-fake-pid) 2>/dev/null ; sleep 0.3

DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  timeout 8 python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-loop.json --loop 2>&1 | tail -10
echo "(timeout exited)"
```

期待: `push FAILED: push failed: Connection refused` が複数行 (毎 interval ごとに 1 回)。最後の行が `(timeout exited)` でプロセスが死なずに timeout(8) が殺してくれた状態。

- [ ] **Step 6: クリーンアップ**

```bash
rm -f /tmp/metrics-fake-pid /tmp/metrics-fake-server.log /tmp/metrics-test-loop.json
```

- [ ] **Step 7: Commit**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git add metrics/runner.py
git commit -m "feat(metrics): --loop と per-command interval スケジューラ

next_run_at 辞書で各コマンドの次回実行時刻を管理し、due になった
ものから直列実行する。push 失敗 (SystemExit) は catch してログだけ
出しループ継続 — 一時的 NW 不調で daemon を殺さないため。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: シグナルハンドリング (graceful shutdown)

**Files:**
- Modify: `metrics/runner.py` (シグナルハンドラ追加、`run_loop` のループ条件変更)

`SIGTERM` と `SIGINT` を受けて、現在実行中のコマンドが終わったら exit 0。`--loop` 中の Ctrl-C でスタックトレースが出ない・実行中コマンドが中断されないようにする。

- [ ] **Step 1: シグナルハンドラとフラグを追加**

`runner.py` の import 群に追加:

```python
import signal
```

`from db import push` の下に追加:

```python
_shutdown_requested = False


def _request_shutdown(signum: int, _frame: object) -> None:
    """SIGTERM/SIGINT で shutdown フラグを立てる。

    実装はフラグを立てるだけで、ループ側が次の iteration で見て抜ける。
    現在実行中のコマンドは subprocess なので signal の影響を受けない。
    """
    global _shutdown_requested
    _shutdown_requested = True
    sig_name = signal.Signals(signum).name
    print(f"[{_ts()}] received {sig_name}, shutting down after current command...",
          file=sys.stderr, flush=True)


signal.signal(signal.SIGTERM, _request_shutdown)
signal.signal(signal.SIGINT, _request_shutdown)
```

`run_loop` 全体を以下の完全版で置換 (Task 4 で書いたものを丸ごと書き換える):

```python
def run_loop(config: Config) -> int:
    """常駐ループ。各コマンドは独立した next_run_at で due になったら実行。

    push 失敗 (SystemExit) は catch して継続 — 一時的 NW 不調で daemon を
    死なせないため。SIGTERM/SIGINT 受信時は現在のコマンドが終わるのを
    待って正常終了する。
    """
    n = len(config.commands)
    next_run_at: List[float] = [0.0] * n

    print(f"[{_ts()}] starting loop: {n} commands, host={config.host}",
          flush=True)

    while not _shutdown_requested:
        now = time.monotonic()
        for i, cmd in enumerate(config.commands):
            if _shutdown_requested:
                break
            if next_run_at[i] <= now:
                started = time.monotonic()
                output = _run_subprocess(cmd)
                try:
                    push(config.host, cmd.command, output, category=cmd.category)
                    elapsed_ms = int((time.monotonic() - started) * 1000)
                    print(f"[{_ts()}] {cmd.command} → push ok ({elapsed_ms}ms)",
                          flush=True)
                except SystemExit as e:
                    print(f"[{_ts()}] {cmd.command} → push FAILED: {e}",
                          flush=True, file=sys.stderr)
                next_run_at[i] = time.monotonic() + cmd.interval_seconds

        if _shutdown_requested:
            break

        sleep_for = max(1.0, min(next_run_at) - time.monotonic())
        slept = 0.0
        while slept < sleep_for and not _shutdown_requested:
            chunk = min(0.5, sleep_for - slept)
            time.sleep(chunk)
            slept += chunk

    print(f"[{_ts()}] loop exited cleanly", file=sys.stderr, flush=True)
    return 0
```

- [ ] **Step 2: SIGTERM テスト用 config を準備し fake サーバを起動**

```bash
cat > /tmp/metrics-test-loop.json <<'JSON'
{
  "host": "sig-test",
  "default_interval_seconds": 3,
  "commands": [
    {"category": "fast", "command": "echo-fast", "argv": ["echo", "fast"]}
  ]
}
JSON

python3 - <<'PY' > /tmp/metrics-fake-server.log 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8765), H).serve_forever()
PY
SERVER_PID=$!
echo "$SERVER_PID" > /tmp/metrics-fake-pid
sleep 0.3
```

- [ ] **Step 3: SIGTERM で graceful shutdown を検証**

```bash
DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-loop.json --loop &
RUNNER_PID=$!
sleep 5  # 数回 push させる
kill -TERM $RUNNER_PID
wait $RUNNER_PID ; echo "runner exit=$?"
```

期待出力末尾:
```
[...] received SIGTERM, shutting down after current command...
[...] loop exited cleanly
runner exit=0
```

- [ ] **Step 4: SIGINT (Ctrl-C 相当) でも同様に graceful shutdown を検証**

```bash
DASHBOARD_URL=http://127.0.0.1:8765 WRITE_TOKEN=test \
  python3 /Users/aida/PhpstormProjects/web-dashboard/metrics/runner.py \
  /tmp/metrics-test-loop.json --loop &
RUNNER_PID=$!
sleep 5
kill -INT $RUNNER_PID
wait $RUNNER_PID ; echo "runner exit=$?"
```

期待: `received SIGINT, shutting down ...` → `loop exited cleanly` → `runner exit=0`。スタックトレースが出ないこと。

- [ ] **Step 5: クリーンアップ**

```bash
kill $(cat /tmp/metrics-fake-pid) 2>/dev/null
rm -f /tmp/metrics-fake-pid /tmp/metrics-fake-server.log /tmp/metrics-test-loop.json
```

- [ ] **Step 6: Commit**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git add metrics/runner.py
git commit -m "feat(metrics): SIGTERM/SIGINT で graceful shutdown

シグナル受信時はフラグを立て、ループの次 iteration で抜ける。
実行中の subprocess は signal の影響を受けないので「現在のコマンドが
終わったら exit 0」になる。Ctrl-C のスタックトレースも消える。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Miyabi 用サンプル config

**Files:**
- Create: `metrics/config/miyabi.json`

実機未確認のコマンドは入れず、PBS 標準の `pbsnodes -aSj` と `qstat` のみで初期サンプルにする。`token_show` 等の Miyabi 固有コマンドは実機で名前確認後に追記する方針 (spec 通り)。

- [ ] **Step 1: ディレクトリと config を作成**

```bash
mkdir -p /Users/aida/PhpstormProjects/web-dashboard/metrics/config
cat > /Users/aida/PhpstormProjects/web-dashboard/metrics/config/miyabi.json <<'JSON'
{
  "host": "miyabi",
  "default_interval_seconds": 180,
  "commands": [
    {
      "category": "ノード使用率",
      "command": "pbsnodes -aSj",
      "argv": ["pbsnodes", "-aSj"]
    },
    {
      "category": "ジョブ一覧",
      "command": "qstat",
      "argv": ["qstat"]
    }
  ]
}
JSON
```

- [ ] **Step 2: config が正しく読めることを検証**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard/metrics && python3 -c "
from runner import load_config
from pathlib import Path
c = load_config(Path('config/miyabi.json'))
print('host:', c.host)
for cmd in c.commands:
    print(f'  [{cmd.category}] {cmd.command} (interval={cmd.interval_seconds}s)')
"
```

期待出力:
```
host: miyabi
  [ノード使用率] pbsnodes -aSj (interval=180.0s)
  [ジョブ一覧] qstat (interval=180.0s)
```

- [ ] **Step 3: Commit**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git add metrics/config/miyabi.json
git commit -m "feat(metrics): Miyabi 用サンプル config を追加

PBS 標準の pbsnodes -aSj (ノード使用率) と qstat (ジョブ一覧) のみ。
token_show 等の Miyabi 固有コマンドは実機で名前確認後に追記する。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: README 更新

**Files:**
- Modify: `metrics/README.md`

"Adding a new host or command" セクションを 2 段構えにする: (1) 1 ホスト 1 コマンドなら `example.py` をコピー (既存)、(2) 複数コマンド / 細かい interval なら `runner.py` + config (新規)。

- [ ] **Step 1: README を以下のように差し替え**

`metrics/README.md` の "Adding a new host or command" セクション以降をすべて以下に置換 (`## Why Python and not bash` の前まで):

```markdown
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
      "command": "pbsnodes -aSj",
      "argv": ["pbsnodes", "-aSj"]
    },
    {
      "category": "ジョブ一覧",
      "command": "qstat",
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
- `commands[].command` — 表示用ラベル
- `commands[].argv` — 実行する引数配列 (`shell=False` で実行)
- `commands[].interval_seconds` — このコマンド固有の interval (override)
- `commands[].timeout_seconds` — このコマンド固有のタイムアウト (override)

実行:

```sh
# 本番 (常駐ループ — デフォルト)
DASHBOARD_URL=http://mado.example WRITE_TOKEN=xxx \
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
```

- [ ] **Step 2: README を git diff でレビュー**

```bash
cd /Users/aida/PhpstormProjects/web-dashboard
git diff metrics/README.md | head -100
```

期待: "Adding a new host or command" 以降が新内容に置換されている。`## Why Python and not bash` セクションは触らずに残っている。

- [ ] **Step 3: Commit**

```bash
git add metrics/README.md
git commit -m "docs(metrics): README に runner.py の使い方を追記

A) 1 ホスト 1 コマンド → example.py コピー (既存パス)
B) 複数コマンド / 細かい interval → runner.py + JSON config (新規)
の 2 段構え。Miyabi 想定の config 例とデプロイ手順も載せた。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 完了基準

すべて満たしたら本プランは完了:

- [ ] `metrics/runner.py` が単体で動く (config を渡せば `--once` / `--loop` の両方で動作)
- [ ] `metrics/config/miyabi.json` が存在し runner で読める
- [ ] `metrics/README.md` が `runner.py` の使い方を含む
- [ ] `metrics/db.py` / `metrics/example.py` は変更なし
- [ ] `--loop` で SIGTERM / Ctrl-C を受けると graceful shutdown
- [ ] push 失敗時、`--loop` はログ継続、`--once` は非ゼロ exit
- [ ] `git log` を見ると Task 単位でコミットが分かれている (1 タスク = 1 commit)
