"""メトリクスコレクター共通のプッシュクライアント。

`push(host, command, output, category=...)` は生の stdout を
ダッシュボードの `/api/external/metrics/push` エンドポイントに POST する。
環境変数から `DASHBOARD_URL` と `WRITE_TOKEN` を読み取る
(通常はソースホスト上で cron 行ごとに設定)。

import 時に `metrics/.env` があれば自動で読み込んで `os.environ` に
流し込む (既存の環境変数は上書きしない)。サンプルは `.env.example` 参照。

標準ライブラリのみ使用 — 多くのターゲットホストは `pip install` できる環境がなく、
標準イメージの Python は 3.8 の場合がある。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def _load_dotenv() -> None:
    """`metrics/.env` があれば KEY=VALUE を `os.environ` に流す。

    - 既存の環境変数は上書きしない (CLI から `DASHBOARD_URL=... python ...`
      で渡したものを優先)。
    - 行頭 `#` のコメントと空行はスキップ。`export KEY=VALUE` 形式も許容。
    - 値の両端のシングル/ダブルクォートだけ剥がす。エスケープシーケンスや
      行末コメントは解釈しない (シンプルさ優先 — 必要なら python-dotenv へ移行)。
    - ファイル不存在/パースエラーで sys.exit はしない (.env は任意なので)。
    """
    env_file = Path(__file__).resolve().parent / ".env"
    if not env_file.is_file():
        return
    try:
        text = env_file.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()


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
