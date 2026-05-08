# Metrics ランナー (config 駆動の常駐コレクター)

## 背景

現在 `metrics/` 配下のコレクターはホストごと/コマンドごとに 1 ファイル (`example.py` を雛形にコピー) を作る前提で、cron から 5 分間隔で起動する設計になっている。

これは 1 ホスト 1 コマンドなら問題ないが、Miyabi (東大スパコン) のように **同じホストから複数コマンドを継続的に取りたい** ケースで以下の不便がある:

1. **コマンドごとにファイルを増やすのが煩雑** — `miyabi-qstat.py` / `miyabi-pbsnodes.py` / `miyabi-tokens.py` … のように HOST/COMMAND/CATEGORY/ARGV だけ違うほぼ同じファイルが並ぶ。
2. **180 秒間隔のような細かい周期は cron 粒度 (1 分) では辛い** — Miyabi のジョブ状況は cron の最短粒度より短い周期で見たい。
3. **コマンドごとに interval を変えたい** — 軽い `qstat` は 3 分、重い `token_show` は 10 分、のような出し分けが現状できない。

## 目的

1 つのメインスクリプト + per-host JSON config に集約し、複数コマンドを per-command interval で push できる常駐ランナーを追加する。既存の `db.py` (push helper) と `example.py` (最小例) は触らない。

## 影響ファイル

- `metrics/runner.py` — **新規** (config 駆動のメインエントリ)
- `metrics/config/miyabi.json` — **新規** (Miyabi 用設定の初期サンプル)
- `metrics/README.md` — runner の使い方を追記
- `metrics/db.py` — **変更なし** (`push()` をそのまま再利用)
- `metrics/example.py` — **残す** (1 コマンド最小例として有用、削除しない)

API・ダッシュボード側 (`/api/external/metrics/push`) は触らない。

## 構成

```
metrics/
├── db.py              # 既存・変更なし
├── runner.py          # NEW
├── config/
│   └── miyabi.json    # NEW
├── example.py         # 既存・残す (最小例)
└── README.md          # 更新
```

### 制約

- **標準ライブラリのみ。** ターゲットホスト (Miyabi 等) は `pip install` できない前提。`json` / `argparse` / `subprocess` / `time` / `pathlib` は stdlib なので問題なし。
- **Python 3.8+。** `db.py` と同じ要件を維持。
- **ホストへの deploy は scp 1 発で済む。** `metrics/` ディレクトリ全体をコピーする現運用を変えない。

## Config フォーマット

`metrics/config/<host>.json`:

```json
{
  "host": "miyabi",
  "default_interval_seconds": 180,
  "default_timeout_seconds": 30,
  "commands": [
    {
      "category": "ノード使用率",
      "command": "pbsnodes -aSj",
      "argv": ["pbsnodes", "-aSj"]
    },
    {
      "category": "トークン使用率",
      "command": "token_show",
      "argv": ["token_show"],
      "interval_seconds": 600
    },
    {
      "category": "ジョブ一覧",
      "command": "qstat",
      "argv": ["qstat"]
    }
  ]
}
```

### フィールド

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `host` | ✓ | ダッシュボードの `host` (db.push 第 1 引数)。1 ファイル = 1 ホスト分。 |
| `default_interval_seconds` | — | 各コマンドの interval 既定値。省略時 180。 |
| `default_timeout_seconds` | — | 各コマンドのタイムアウト既定値。省略時 30。 |
| `commands[].category` | ✓ | ダッシュボードのセクション見出し (db.push の `category=`)。日本語可。 |
| `commands[].command` | ✓ | 表示用ラベル (db.push 第 2 引数)。 |
| `commands[].argv` | ✓ | 実行する引数配列 (`subprocess.run(argv, ...)` にそのまま渡す)。 |
| `commands[].interval_seconds` | — | このコマンド固有の interval。未指定なら `default_interval_seconds` 継承。 |
| `commands[].timeout_seconds` | — | このコマンド固有のタイムアウト。未指定なら `default_timeout_seconds` 継承。 |

### 設計判断

- **`command` (ラベル) と `argv` (実コマンド) を分離。** `qstat -fxw` のような長い引数列でも、表示は `qstat` だけにしたいケースを許容するため。
- **`argv` は配列のみ受ける (文字列は受け付けない)。** shell injection を避け、`shell=False` で `subprocess.run` するため。シェル展開が要るケースは `argv: ["sh", "-c", "..."]` で明示的に書く。
- **interval / timeout はトップレベル default + per-command override。** Miyabi のように「ほとんど 180s だが 1 つだけ 600s」のような形を簡潔に書ける。
- **`host` はトップレベル 1 つだけ** — 1 ファイルで複数ホストを束ねる構造はとらない。host ごとに config を分けたほうが scp しやすく、責務もシンプル。

## CLI

```sh
# 本番 (常駐ループ — デフォルト)
DASHBOARD_URL=http://mado.lan WRITE_TOKEN=xxx \
  python3 ~/mado/metrics/runner.py config/miyabi.json

# 単発実行 (cron / 手動テスト用)
python3 runner.py config/miyabi.json --once

# 特定コマンドだけ実行 (デバッグ)
python3 runner.py config/miyabi.json --once --only "ノード使用率"
```

### 引数

| 引数 | 説明 |
|------|------|
| `<config>` (位置引数) | config JSON へのパス。 |
| `--loop` | 常駐ループ (デフォルト)。 |
| `--once` | 全コマンドを 1 回ずつ実行して exit。`--loop` と排他。 |
| `--only <category-or-command>` | category または command が一致するもののみ実行。`--once` と組み合わせて使う想定。 |

### 設計判断

- **`--loop` をデフォルト。** 主目的が常駐 push なので、引数なし起動 = 常駐とする。
- **`--once` を残す理由は 3 つ:** (1) 新 config の動作確認を手元で 1 回回せる、(2) 何らかの理由で cron に戻したくなったときの逃げ道、(3) `--only` と組み合わせた特定コマンドのデバッグ。実装コストは ~10 行。
- **`--only` は category と command の両方にマッチ。** 「ノード使用率」(category) でも `pbsnodes -aSj` (command) でも指定できると、デバッグ時に手数が減る。マッチは部分一致ではなく完全一致 (大文字小文字も区別)。

## 振る舞い

### ループスケジューリング

```python
next_run_at: dict[int, float] = {i: 0.0 for i in range(len(commands))}

while True:
    now = time.monotonic()
    for i, cmd in enumerate(commands):
        if next_run_at[i] <= now:
            run_one(cmd)                                # 直列実行
            next_run_at[i] = time.monotonic() + cmd.interval_seconds
    sleep_for = max(1.0, min(next_run_at.values()) - time.monotonic())
    time.sleep(sleep_for)
```

- **直列実行。** 想定するコマンド数 (3〜5 個) と実行時間 (それぞれ ~数秒) なら、トータル 30 秒未満で 1 サイクル完了する。並列化 (threading) は overkill かつデバッグ性を下げる。
- **`time.monotonic()` を使う** — システム時刻の巻き戻し (NTP 同期、サマータイム) に影響されない。
- **`next_run_at` は「次に due になる時刻」** を保持。各 tick で due なコマンドだけを実行することで per-command interval が崩れない。
- **コマンド実行中に他コマンドが due になっても OK。** ループ次回の iteration で拾われる。直列の遅延は許容 (HPC 監視で 1〜2 秒のずれは無視できる)。
- **最低 sleep を 1 秒**にする (busy loop 防止)。

### 単一コマンド実行 (`run_one`)

```python
def run_one(cmd: Command) -> None:
    started = time.monotonic()
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
    except subprocess.TimeoutExpired as e:
        raw = e.stdout
        partial = (
            raw.decode("utf-8", errors="replace")
            if isinstance(raw, bytes) else (raw or "")
        )
        output = (
            f"{partial}\n--- timeout ---\n"
            f"command timed out after {cmd.timeout_seconds}s\n"
        )
    except FileNotFoundError:
        output = f"--- error ---\ncommand not found: {cmd.argv[0]}\n"

    try:
        push(host, cmd.command, output, category=cmd.category)
        log_ok(cmd, time.monotonic() - started)
    except SystemExit as e:                         # db.push は失敗時 sys.exit する
        log_push_failed(cmd, str(e))                # ループは継続
```

- **失敗時の挙動は既存 `example.py` と同じ** — exit≠0 なら stderr と exit code を output に追記して push する。「結果が見えないより、失敗したことが見えるほうがよい」原則。
- **タイムアウト時も push する。** "command timed out after Xs" を本文として送ると、ダッシュボードに「タイムアウトしました」が表示され、サイレント断より気付きやすい。
- **`FileNotFoundError` (argv の実行ファイルが存在しない) も catch。** config のタイポやコマンド未インストール時の早期可視化。
- **`db.push` は失敗時 `sys.exit()` する** (現実装) → daemon ではプロセスごと死ぬのを避ける必要がある。`SystemExit` を catch してログだけ出してループ継続する。
  - 単発モード (`--once`) では catch せず、push 失敗を非ゼロ exit で伝える (cron の `MAILTO` で気付ける)。
- **環境変数 (`DASHBOARD_URL` / `WRITE_TOKEN`) は `db.push` 内でチェックされる。** runner.py 側で重複検査はしない (DRY)。

### ロギング (stdout)

```
[2026-05-08T10:00:00+09:00] qstat → push ok (245ms)
[2026-05-08T10:00:01+09:00] token_show → push ok (89ms)
[2026-05-08T10:00:02+09:00] pbsnodes -aSj → timeout after 30s, pushed error
[2026-05-08T10:00:03+09:00] qstat → push FAILED: HTTP 401 Unauthorized
```

- **stdout のみ** (logging モジュールは使わない、stdlib 内だが設定が増えるので)。
- **タイムスタンプは ISO8601 + ローカル TZ。** 運用者が直接読む想定で human-friendly に。
- **push 失敗 (`FAILED`) もログには出すが exit はしない。** 一時的な NW 不調で daemon が落ちると復旧が手間。

### シャットダウン

- `KeyboardInterrupt` (Ctrl-C) と `SIGTERM` を catch し、現在実行中のコマンドが終わった時点で正常終了 (exit 0)。
- `signal.signal(SIGTERM, handler)` で `_shutdown_requested = True` を立て、ループ先頭で見るだけ。複雑な signal handling は入れない。

## サンプル config (`metrics/config/miyabi.json`)

リポジトリには Miyabi 向け初期サンプルとして以下を含める:

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

`token_show` 等の Miyabi 固有コマンドは、実機で名前を確認してから追記する。サンプルは「動くと確証のあるもの」だけにとどめる。

## README 更新

`metrics/README.md` の "Adding a new host or command" セクションを以下の構成にする:

1. **シンプルな 1 ホスト 1 コマンド** → `example.py` をコピーして使う (既存のまま、最小例として残す)
2. **複数コマンド / 細かい interval** → `runner.py` + `config/<host>.json` を使う (新規セクション)

`example.py` を残す理由として「最小例」「コピペで動く 1 ファイル」「db.py の使い方デモ」を README に明記する。

## テスト

`metrics/` 配下に既存テストはなく、ターゲットホスト上で動くことが本質的に重要なので自動テストは追加しない。代わりに以下を README の "動作確認" セクションに記載:

1. `--once` で全コマンドが push できる:
   ```sh
   DASHBOARD_URL=... WRITE_TOKEN=... \
     python3 runner.py config/miyabi.json --once
   ```
   → 各コマンドの結果がダッシュボードに表示される。
2. `--once --only <category>` で 1 つだけ実行できる。
3. 存在しない argv (`["nonexistent_cmd"]`) を仕込んで `--once` → "command not found" が push される (ダッシュボードで確認)。
4. timeout を 1 秒に設定し `["sleep", "10"]` を仕込んで `--once` → "timed out after 1s" が push される。
5. `--loop` で 5 分以上動かし、`next_run_at` が崩れない (ログのタイムスタンプ間隔が interval と整合する) ことを目視確認。
6. Ctrl-C で正常終了する (途中で hang しない)。

## デプロイ

既存の scp 手順をそのまま使う:

```sh
scp -r metrics you@miyabi:~/mado/metrics/
ssh you@miyabi 'nohup env DASHBOARD_URL=... WRITE_TOKEN=... \
  python3 ~/mado/metrics/runner.py ~/mado/metrics/config/miyabi.json \
  > ~/mado/metrics/runner.log 2>&1 &'
```

systemd / launchd ユニット化は将来の検討事項とし、本変更には含めない (まず動かして必要性を見極める)。

## ロールバック

新規ファイルの追加 + README の追記のみで、既存の `db.py` / `example.py` / API は触らない。問題があれば `runner.py` と `config/` を消すだけで元に戻る。
