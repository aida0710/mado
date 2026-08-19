# 汎用ジョブキュー

## 背景

ディレクトリ配下のオブジェクト数・サイズを数える機能を作るにあたり、当初は同期リクエストで設計していた。しかし所要時間の見積もり (`dataset` 全体で 223 秒、実測) に対して「タイムアウト 10 分・上限なし」という要求が出た時点で、同期方式は破綻した。

- nginx の `proxy_read_timeout` は 300 秒。10 分の走査は 5 分で切られる
- 上げれば通るが、`/api/internal/` 全体にかかるため、上流が詰まった他のリクエストも 11 分ぶら下がるようになる
- 10 分間 HTTP 接続を保持する設計は、ブラウザのタブを閉じただけでサーバー側が走り続ける

そこでキュー + ポーリング方式に切り替える。あわせて、今後足す予定のジョブ (走査系のバリエーション、ファイル中身の解析、キャッシュのプリウォーム) を同じ土台に載せられるよう、種別に依存しない汎用の設計にする。

## この設計が背負う経緯

**同種のジョブ基盤は `9cd6881` で一度削除されている**。旧 `media_jobs` はディレクトリ / tar スキャン専用で、キュー・進捗ポーリング・キャンセル・worker のジョブループ・stale 再投入を備えていた。削除の理由は **「UI / ジョブ管理が煩雑だった」**。

今回それを再導入する以上、**複雑さに見合う設計にする責任がある**。旧実装から明示的に変える点は 3 つ:

1. **進捗にパーセンテージを強制しない** (後述「進捗の契約」)
2. **`attempts` による poison job の打ち切り** — 旧実装の `requeueStale` は worker を必ず落とすジョブを無限に再投入しうる形だった
3. **種別ごとの専用テーブルを作らない** — 旧実装は `media_jobs` と `dataset_stats` に分かれていた。結果は `jobs.result` に入れ、最新結果は「最後に成功したジョブ」を引く

一方、旧実装で妥当だった判断は引き継ぐ。実行中の同一対象を 1 本に合流させる部分一意インデックスと、`id` を `SERIAL` (int4) にする判断 (pg ドライバは int8 を文字列で返すため、フロントの `z.number()` と揃わない) は、当時のコメントに理由が残っており、そのまま採用する。

## 目的

- 数分〜数十分かかる処理を、HTTP 接続を保持せずに実行できる
- 新しいジョブ種別を「ハンドラ関数を 1 つ書いて登録する」だけで足せる
- 実行中の様子 (進捗) が見え、途中で止められる

## スコープ外

- **複数 worker での水平スケール**。worker は 1 台、同時実行は 1 件。必要になったら claim は既に `SKIP LOCKED` なので worker を増やすだけで動く
- **リトライのバックオフ / 優先度**。ジョブは人が押すか定期実行で投入され、失敗したら人が押し直せばよい
- **cron スケジューリング**。定期実行のジョブ種別を足すときに、worker のループから投入する形で実装する
- **書き込みを伴うジョブ** (一括削除・コピー等)。確認フローや権限ガードの設計が別途要るため、本仕様では扱わない

## なぜ pg-boss ではなく自前か

pg-boss や graphile-worker はリトライ・可視性タイムアウト・cron・アーカイブを備えており、機能面では上位互換である。それでも自前にする理由:

- **土台が残っている**。`media-worker` コンテナ、DB プール、storage factory、worker の HTTP サーバとループの外枠は削除されずに現存する。旧 `media_jobs` のスキーマも実績があり、`kind` を足すだけで汎用化できる
- **スキーマの一貫性**。このリポジトリは「`db/migrations/*.sql` がスキーマの source of truth」という設計で、`db/README.md` にも明記されている。pg-boss は自前のスキーマを自分で作って管理するため、マイグレーション管理外のテーブル群が入り込む
- **依存を増やさない**。`api/` の依存は 8 個 (`@aws-sdk/client-s3`, `@hono/node-server`, `hono`, `lzma-native`, `nanoid`, `pg`, `tar-stream`, `zod`) に抑えられている

pg-boss が有利になるのは、リトライのバックオフ・複数 worker・優先度が必要になったとき。そのときは移行を検討する。

## スキーマ

`db/migrations/017_jobs.sql`:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  -- SERIAL (int4): pg ドライバは int8 を string で返すため、フロントの
  -- z.number() と揃えて int4 にする (旧 media_jobs と同じ判断)。
  id           SERIAL PRIMARY KEY,
  kind         TEXT        NOT NULL,
  -- 同一対象の判定に使う。種別ごとに意味を決める (走査なら connId/bucket/prefix)。
  dedup_key    TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','error','canceled')),
  progress     JSONB,
  result       JSONB,
  error        TEXT,
  attempts     INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

-- 実行中 (queued/running) の同一対象は 1 本に合流させる。
-- done/error/canceled の行が残っていても再投入はできる。
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active
  ON jobs (kind, dedup_key) WHERE status IN ('queued','running');

-- claim 用。queued だけを見る部分インデックス。
CREATE INDEX IF NOT EXISTS jobs_claim
  ON jobs (created_at) WHERE status = 'queued';

-- 「最後に成功したジョブ」を引く用。結果ストアを兼ねる。
CREATE INDEX IF NOT EXISTS jobs_latest
  ON jobs (kind, dedup_key, finished_at DESC) WHERE status = 'done';

ALTER TABLE    jobs        OWNER TO dashboard_rw;
ALTER SEQUENCE jobs_id_seq OWNER TO dashboard_rw;
GRANT SELECT ON jobs TO dashboard_ro;
```

## ステータス遷移

```
queued ──claim──> running ──成功──> done
   │                 │
   │                 └──throw──> error
   │                 │
   │                 └──heartbeat 途絶 (attempts < 3)──> queued
   │                 └──heartbeat 途絶 (attempts >= 3)──> error
   │
   └──cancel──> canceled        running ──cancel──> canceled
```

## claim

```sql
UPDATE jobs SET status = 'running', started_at = now(), heartbeat_at = now(), attempts = attempts + 1
 WHERE id = (
   SELECT id FROM jobs WHERE status = 'queued'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
 )
 RETURNING id, kind, payload;
```

`SKIP LOCKED` なので、将来 worker を増やしても取り合いにならない。

## worker 死亡の検出

ハンドラは処理の合間に `heartbeat_at` を打つ。**2 分**以上途絶えた `running` のジョブは、worker が死んだとみなす。

- `attempts < 3` なら `queued` に戻す
- `attempts >= 3` なら `error` にする (`error = 'worker が繰り返し停止しました'`)

旧実装の `requeueStale` には試行回数の概念が無く、worker を必ず落とすジョブが無限に再投入されうる形だった。`attempts` はその再発防止である。

## 進捗の契約

**パーセンテージを強制しない。** 総数が分からない処理は存在する — S3 には件数を返す API が無く、オブジェクト数を知るには列挙するしかないため、初回の走査では分母が原理的に出せない。

```typescript
export type JobProgress =
  /** 総数が分からない処理。UI は不定表示 (スピナー + 件数)。 */
  | { kind: 'count'; done: number; label?: string }
  /** 総数が分かる処理。UI はパーセンテージを出す。 */
  | { kind: 'ratio'; done: number; total: number; label?: string }
```

基盤としては両方を扱えるが、**ハンドラが `ratio` を返せるときだけパーセンテージが出る**。走査ハンドラは v1 では `count` を返す。

旧実装の進捗は `{filesDone, filesTotal, currentKey}` で `filesTotal` を必須にしており、それを出すために事前に数える必要があった。ここが煩雑さの一因だったと判断している。

更新は**最大 2 秒に 1 回**に絞る。ハンドラは毎ページ `setProgress` を呼んでよく、間引きは基盤側で行う。

## キャンセル

`POST /jobs/:id/cancel` が `status` を `canceled` にする。専用のフラグ列は作らない。

ハンドラは `JobContext.signal` を見て中断する。基盤は heartbeat と同じ 2 秒周期で `status` を読み、`canceled` なら `AbortController` を abort する。

## ハンドラの登録

```typescript
export interface JobContext {
  payload: unknown
  /** canceled になったら abort される。長い処理はこれを見て抜ける。 */
  signal: AbortSignal
  /** 呼び放題。書き込みは 2 秒に 1 回に間引かれる。 */
  setProgress(p: JobProgress): void
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>

/** kind → handler。新しいジョブ種別はここに 1 行足す。 */
export const handlers: Record<string, JobHandler> = {
  'storage.scan': scanHandler,
}
```

戻り値が `result` に入り、throw すると `error` になる。ハンドラは `payload` の検証を自分で行う (zod)。

## API

| endpoint | 用途 |
| --- | --- |
| `GET /jobs/:id` | status / progress / result / error |
| `POST /jobs/:id/cancel` | キャンセル |
| `GET /jobs/latest?kind=&dedupKey=` | 最後に成功したジョブ (結果の閲覧) |

**ジョブの投入は種別ごとのエンドポイントで行う。** 汎用の `POST /jobs` は作らない。任意の `kind` と `payload` を外から投げられる口は、権限の観点でも入力検証の観点でも面倒が多く、種別ごとに専用の口を持つ方が素直なため (走査なら `POST /storage/:connId/scan`)。

投入時、同一対象の実行中ジョブがあれば**新規作成せずその id を返す** (部分一意インデックスによる合流)。

フロントは `queued` / `running` の間だけ 1 秒間隔でポーリングし、終端状態で止める。

## 行の保持

`(kind, dedup_key)` ごとに**最新の完了ジョブは無期限に残す**。最新行が結果ストアを兼ねるため消せない。

それより古い完了ジョブ (`done` / `error` / `canceled`) は **7 日**で削除する。worker の起動時と 1 日 1 回実行する。

```sql
DELETE FROM jobs j
 WHERE j.status IN ('done','error','canceled')
   AND j.finished_at < now() - interval '7 days'
   AND EXISTS (
     SELECT 1 FROM jobs n
      WHERE n.kind = j.kind AND n.dedup_key = j.dedup_key
        AND n.status = 'done' AND n.finished_at > j.finished_at
   );
```

## worker への組み込み

`api/worker.ts` (media-worker コンテナ) にジョブループを戻す。HTTP サーバ (`/analyze`, `/healthz`) とループの外枠は現存するので、`claimNextJob` → ハンドラ実行 → 結果保存の部分を足す。

ポーリング間隔は 2 秒。`queued` が無ければ待つだけなので、DB への負荷は無視できる。

## エラーと縮退

- ハンドラが throw → `status = 'error'`、`error` にメッセージ。**呼び出し側は再投入すればよい**ので、自動リトライは行わない
- 進捗の書き込みが失敗しても処理は続ける (進捗は補助情報)
- DB が落ちていれば worker はループを続けながらリトライする (旧実装の「起動直後に DB 未到達でも worker を殺さない」を踏襲)

## テスト

- claim が `SKIP LOCKED` で 1 件だけ取ること、同時 claim で二重に取らないこと (実 DB)
- 部分一意インデックスにより、実行中の同一対象を二重投入できないこと (実 DB)
- heartbeat 途絶で `queued` に戻ること、`attempts >= 3` で `error` になること
- `setProgress` が 2 秒に間引かれること (純ロジック、時計を注入)
- キャンセルで `signal` が abort されること
- 保持クエリが「最新の done を残して古い行だけ消す」こと (実 DB)

## 受け入れ確認

1. 走査ジョブを投入 → `GET /jobs/:id` が `queued` → `running` → `done` と遷移する
2. 実行中に同じ対象をもう一度投入 → 同じ id が返る (新しい行が増えない)
3. 実行中にキャンセル → 数秒以内に `canceled` になる
4. 実行中に worker を再起動 → 2 分後に `queued` へ戻り、再実行される
5. `progress` が 2 秒程度の間隔で更新される

## 将来の拡張

- **定期実行**: worker のループから「次に実行すべき定期ジョブ」を投入する。cron 式が必要になれば `node-cron` 相当を足す
- **複数 worker**: claim は既に `SKIP LOCKED` なので、コンテナを増やすだけで動く
- **リトライのバックオフ / 優先度**: 必要になったら pg-boss への移行を検討する
