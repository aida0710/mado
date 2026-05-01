"""メトリクスコレクター共通のプッシュクライアント。

`push(host, command, output, category=...)` は生の stdout を
ダッシュボードの `/api/external/metrics/push` エンドポイントに POST する。
環境変数から `DASHBOARD_URL` と `WRITE_TOKEN` を読み取る
(通常はソースホスト上で cron 行ごとに設定)。

標準ライブラリのみ使用 — 多くのターゲットホストは `pip install` できる環境がなく、
標準イメージの Python は 3.8 の場合がある。
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
    """text/plain として /api/external/metrics/push に `output` を POST する。

    `category` はフロントエンドがカードをセクションごとにグループ化する際に
    使用する自由文字列 — 例: "load"、"ジョブ一覧"、"node使用率"。

    設定エラーや HTTP 失敗時はゼロ以外のステータスでプロセスを終了し、
    cron の `MAILTO` に問題を通知する。
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
