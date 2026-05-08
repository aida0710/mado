"""メトリクスコレクター共通のプッシュクライアント。

`push(host, command, output, category=...)` は生の stdout を
ダッシュボードの `/api/external/metrics/push` エンドポイントに POST する。
環境変数から `DASHBOARD_URL` と `WRITE_TOKEN` を読み取る。

import 時に `metrics/.env` があれば自動で読み込んで `os.environ` に
流し込む (`python-dotenv` 経由、`uv sync` で導入)。サンプルは
`.env.example` 参照。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv

# `metrics/.env` を読み `os.environ` に流す (見つからなければ no-op)。
# `override=False` がデフォルトなので、シェルで `DASHBOARD_URL=... python ...`
# のように渡した値はそのまま優先される。
load_dotenv(Path(__file__).resolve().parent / ".env")


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
        sys.exit("環境変数 DASHBOARD_URL と WRITE_TOKEN を設定してください")

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
                sys.exit(f"push 失敗: {resp.status} {resp.reason}")
    except HTTPError as e:
        sys.exit(f"push 失敗: HTTP {e.code} {e.reason}")
    except URLError as e:
        sys.exit(f"push 失敗: {e.reason}")
