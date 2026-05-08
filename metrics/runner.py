#!/usr/bin/env python3
"""Config 駆動のメトリクスランナー (常駐 / 単発両対応)。

詳細仕様は docs/superpowers/specs/2026-05-08-metrics-runner-design.md を参照。
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
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


def _to_positive_float(value: object, where: str, path: Path) -> float:
    try:
        result = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as e:
        raise ValueError(
            f"{path}: {where} must be a number, got {value!r}"
        ) from e
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{path}: {where} must be > 0, got {result}")
    return result


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

    default_interval = _to_positive_float(
        raw.get("default_interval_seconds", 180),
        "default_interval_seconds",
        path,
    )
    default_timeout = _to_positive_float(
        raw.get("default_timeout_seconds", 30),
        "default_timeout_seconds",
        path,
    )

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
        for key in ("category", "command"):
            val = c[key]
            if not isinstance(val, str) or not val:
                raise ValueError(
                    f"{path}: commands[{i}].{key} must be a non-empty string"
                )
        if not isinstance(c["argv"], list) or not c["argv"]:
            raise ValueError(
                f"{path}: commands[{i}].argv must be a non-empty array"
            )
        if not all(isinstance(x, str) for x in c["argv"]):
            raise ValueError(
                f"{path}: commands[{i}].argv items must all be strings"
            )
        commands.append(Command(
            category=c["category"],
            command=c["command"],
            argv=list(c["argv"]),
            interval_seconds=_to_positive_float(
                c.get("interval_seconds", default_interval),
                f"commands[{i}].interval_seconds",
                path,
            ),
            timeout_seconds=_to_positive_float(
                c.get("timeout_seconds", default_timeout),
                f"commands[{i}].timeout_seconds",
                path,
            ),
        ))

    return Config(host=host, commands=commands)


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
        raw = e.stdout
        if isinstance(raw, bytes):
            partial = raw.decode("utf-8", errors="replace")
        else:
            partial = raw or ""
        return (
            f"{partial}\n--- timeout ---\n"
            f"command timed out after {cmd.timeout_seconds}s\n"
        )
    except FileNotFoundError:
        return f"--- error ---\ncommand not found: {cmd.argv[0]}\n"


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
        output = _run_subprocess(cmd)
        try:
            push_started = time.monotonic()
            push(config.host, cmd.command, output, category=cmd.category)
            elapsed_ms = int((time.monotonic() - push_started) * 1000)
            print(f"[{_ts()}] {cmd.command} → push ok ({elapsed_ms}ms)",
                  flush=True)
        except SystemExit as e:
            print(f"[{_ts()}] {cmd.command} → push FAILED: {e}",
                  flush=True, file=sys.stderr)
            rc = 1
    if only is not None and matched == 0:
        print(f"[{_ts()}] no commands matched --only {only!r}",
              file=sys.stderr, flush=True)
        rc = 1
    return rc


def run_loop(config: Config) -> int:
    """常駐ループ。各コマンドは独立した next_run_at で due になったら実行。

    push 失敗 (SystemExit) は catch して継続 — 一時的 NW 不調で daemon を
    死なせないため。FATAL なエラー (config 不正など) は load_config 段階で
    既に弾かれているはずなので、ここではループ継続を優先する。
    """
    n = len(config.commands)
    next_run_at: List[float] = [0.0] * n  # 初回は即座に全部走る

    print(f"[{_ts()}] starting loop: {n} commands, host={config.host}",
          flush=True)

    while True:
        now = time.monotonic()
        for i, cmd in enumerate(config.commands):
            if next_run_at[i] <= now:
                output = _run_subprocess(cmd)
                try:
                    push_started = time.monotonic()
                    push(config.host, cmd.command, output, category=cmd.category)
                    elapsed_ms = int((time.monotonic() - push_started) * 1000)
                    print(f"[{_ts()}] {cmd.command} → push ok ({elapsed_ms}ms)",
                          flush=True)
                except SystemExit as e:
                    print(f"[{_ts()}] {cmd.command} → push FAILED: {e}",
                          flush=True, file=sys.stderr)
                next_run_at[i] = time.monotonic() + cmd.interval_seconds

        sleep_for = max(1.0, min(next_run_at) - time.monotonic())
        time.sleep(sleep_for)


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
    return run_loop(cfg)


if __name__ == "__main__":
    sys.exit(main())
