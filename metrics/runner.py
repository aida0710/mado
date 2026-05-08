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
