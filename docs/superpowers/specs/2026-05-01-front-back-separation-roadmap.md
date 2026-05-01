---
title: front / back 分離ロードマップ (P1 → P2 → P3)
date: 2026-05-01
status: planning
authors: aida
---

# front / back 分離ロードマップ

現在の web-dashboard は front と back が密結合している:

- ルートの `package.json` に `workspaces: [front, api]` で両方ぶら下がる
- API プロセス (`api/index.ts:53-60`) が `front/dist/` を配信
- 同一リポ・同一デプロイ単位

これを **3 フェーズに分けて段階的に解く**。本ドキュメントは「決定事項とフェーズ概要」を残すためのロードマップであり、各フェーズの**詳細設計は別 spec で起こす**（次セッション以降）。

---

## 決定事項（2026-05-01）

| 項目 | 決定 | 備考 |
|---|---|---|
| Front の技術 | **React + Vite を据置** | 静的ビルド + 別オリジン or 自前で動的配信 |
| Back の言語 | **FastAPI (Python) に書き換え** | メトリクス収集側 (`metrics/db.py`) が既に Python なのでスタック整合 |
| 内部分離 | **ingest と internal API を別プロセス・別ポート** | 単一コードベース内で 2 app に分割 |
| 順序 | **P1 → P2 → P3** | 各フェーズが終わったら別セッションで次の brainstorm |
| 進め方 | **本セッションでは roadmap のみ作成** | 詳細 spec / plan / 実装は次セッション以降 |

---

## P1. front / back を分離

**目的:** API プロセスが `front/dist/` を配信しなくなる。npm workspaces で front と back が同居しなくなる。**この段階では言語据置（TS + Hono のまま動かす）**。書き直しは P2 で。

### やること（概要）

- ルート `package.json` から `workspaces: [front, api]` を解体
- API の `serveStatic` 配信を撤去（`api/index.ts:53-60` 周辺）
- API は API のみを返すプロセスに（ヘルスチェック + JSON）
- front は独立して配信
  - 開発: `vite dev` (5173) を独立に
  - 本番: `vite build` の出力を `vite preview` or 静的ホスト（nginx 等）
- `vite.config.ts` の `proxy` 設定を見直し（API オリジンが別になる）
- 別オリジンになるので **CORS 設定が必要**

### 残課題（P1 の brainstorm で詰める）

- リポを分ける？それとも同一リポでディレクトリだけ分ける？
- 本番の front をどこで配信するか（`vite preview` / nginx / Vercel / S3+CloudFront）
- CORS 戦略（allowed origins、credentials の扱い）
- Cookie / session ベースの auth に切り替えるなら CSRF も
- `compose.yml` の改訂（DB だけだったのが、API + 場合によっては front 配信も）

### サイズ

数日。既存コードの **移動が中心、書き直しゼロ**。

---

## P2. backend を FastAPI に書き換え

**目的:** Node + Hono から Python + FastAPI へ完全移行。メトリクス収集側と言語スタックが揃う。

### やること（概要）

既存ルート全部を FastAPI に移植:

- `metrics`, `sql`, `storage-list`, `storage-readme`, `storage-preview`, `storage-favorites`, `connections`, `notes`, `settings`
- zod schema → **Pydantic v2 model**
- `pg` (node-postgres) → **asyncpg** or SQLAlchemy Core (async)
- `@aws-sdk/client-s3` → **aioboto3** or boto3
- `crypto.ts` (AES-GCM) → **cryptography パッケージ**
- `requireWriteToken` middleware → **FastAPI Dependency**
- tar/gzip/xz ストリーム処理 → Python stdlib (`tarfile`, `gzip`, `lzma`)
- テスト: vitest → **pytest** (+ httpx)

### 残課題（P2 の brainstorm で詰める）

- async か sync か（FastAPI は async が本流、DB / S3 もそれに合わせる）
- 依存管理: `poetry` / `uv` / `pip + requirements.txt` のどれ
- 移行戦略: 一括 cutover か、ルート単位で並行運用するか
- API 表面の互換性をどこまで保つか（フロントを変えずに済ませるか）
- Postgres 接続プール（asyncpg / SQLAlchemy）
- 本番の起動構成（`uvicorn` + `gunicorn` workers）

### サイズ

1〜2 週間。**API 表面は同じ、内部は完全に別物**。

### 前提

P1 が完了していること（API が独立しているからこそ、言語移行を front に影響を与えずに進められる）。

---

## P3. ingest と internal API を別プロセス・別ポート

**目的:** 「外部 cron 等が叩く ingest（書き込み）」と「ブラウザが叩く internal API（読み取り中心）」を物理的に分離。前セッション (2026-05-01) で議論した「内部 API は外部から呼べる」という現状の解消も兼ねる。

### やること（概要）

- 同一コードベース内で 2 つの FastAPI `app` を定義
- `uvicorn ingest_app:app --port 3001` と `uvicorn internal_app:app --port 3000` を別プロセスで起動（compose で別サービス、または systemd で別 unit）
- **ingest_app**: `POST /api/metrics/push` のみ
- **internal_app**: それ以外（storage / connections / settings / notes / metrics 読み取り / sql / etc.）
- 共通モジュール (`db`, `s3`, `crypto`, `schemas`, `auth`) は両方の app から import
- internal_app は `127.0.0.1` 限定 or LAN CIDR (`10.15.0.0/16` 等) に bind / 制限可能になる

### 残課題（P3 の brainstorm で詰める）

- internal API の bind を `127.0.0.1` 限定にする？それとも LAN CIDR 制限？
- `compose.yml` での 2 サービス化、ヘルスチェック / ログを 2 系統に
- `WRITE_TOKEN` の役割分割（`INGEST_TOKEN` と `ADMIN_TOKEN`）— ヘルプモーダル spec で「将来検討」とした話
- `/sql/write` の扱い（残すなら admin 側、無くすなら別判断）
- CI でも 2 プロセス起動して結合テスト

### サイズ

数日。**コード分割は機械的、運用要素（プロセス・ポート・ログ・監視）が 2 倍に**。

### 前提

P2 完了後を想定（FastAPI の構造で複数 app を切り出すのは Python の文脈に自然）。ただし P1 + 据置 TS のままでも実施は可能（順序の判断は P3 の brainstorm 時に再検討）。

---

## 明示的な「やらない」（roadmap 外）

以下は P1〜P3 のスコープに含めない。やるなら別 spec を起こす:

- 認証システムの追加（cookie session, OIDC, basic auth など）
- `/sql/write` の削除（OSS 化マターとして既存ヘルプモーダル spec の「残課題」に記載済み）
- 多言語対応 (i18n)
- メトリクス TTL の env 可変化（現状 1 時間 hard-code）
- メトリクス収集スクリプト (`metrics/`) 側の見直し
- フロントエンドの大規模 refactor

---

## 関連ドキュメント

- `docs/superpowers/specs/2026-04-30-web-dashboard-design.md` — リポジトリ全体の元設計（旧名 `hpc_*` で記述）
- `docs/superpowers/specs/2026-05-01-metrics-help-modal-design.md` — 同日に確定したヘルプモーダル設計。「サーバー分離 / トークン分割 / OSS 化」を将来課題として明記。本 roadmap の P1+P3 でその一部を回収する

---

## 次セッションへの引き継ぎ

本ドキュメントは roadmap であり、各フェーズの **detailed spec ではない**。次セッションでの動き方:

1. **新セッションを開く**（本セッションの context をリセット）
2. 本ドキュメント (`docs/superpowers/specs/2026-05-01-front-back-separation-roadmap.md`) を最初に読み込ませる
3. **P1 から brainstorming 開始**: 「P1 の詳細設計を brainstorm したい。本 roadmap の P1 セクションを参照」
4. P1 spec → P1 plan → P1 実装 → P1 完了
5. 同様に P2 → P3 と進む

各フェーズが終わったら、本ドキュメントの該当セクションに `status: shipped (commit hash)` のような追記をして履歴を残すのがおすすめ。
