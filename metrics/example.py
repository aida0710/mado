#!/usr/bin/env python3
"""メトリクスコレクターのサンプル: `uptime` の出力をダッシュボードにプッシュする。

任意のターゲットホスト上で cron から実行する。`DASHBOARD_URL` は
接続元によって異なる:

  - LAN 内 (10.15.0.0/16):    http://mado.lan        (nginx :80)
  - LAN 外 (HPC ノード等):    http://<server>:81     (nginx :81、/api/external/ 専用)
  - dev:                      http://mado.lan:5173   (vite dev server)

cron 例 (LAN 内ホスト):

    */5 * * * * DASHBOARD_URL=http://mado.lan \
        WRITE_TOKEN=xxxxxxxx /home/me/mado/metrics/example.py

別のコレクターを追加するにはこのファイルをコピーして
(HOST / COMMAND / CATEGORY / ARGV) を変更する —
例: `df -h /` 用の `df.py`、`vmstat 1 5` 用の `vmstat.py`。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# `python -m metrics.example` を使わずに直接このファイルを実行できるようにする。
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
        # オペレーターが問題を確認できるよう stderr を stdout と一緒にプッシュする。
        output = (
            f"{output}\n--- stderr ---\n{proc.stderr}\n(exit {proc.returncode})\n"
        )
    push(HOST, COMMAND, output, category=CATEGORY)
    return 0


if __name__ == "__main__":
    sys.exit(main())
