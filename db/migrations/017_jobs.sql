-- 汎用ジョブキュー (spec: 2026-08-18-job-queue-design.md)
--
-- 数分〜数十分かかる処理を HTTP 接続を保持せずに実行するための土台。
-- 種別は kind で判別し、worker 側の kind → handler マップで解決する。
--
-- 同種の基盤は 9cd6881 で「UI / ジョブ管理が煩雑」として一度削除された。
-- 再導入にあたり、進捗にパーセンテージを強制しない・attempts で poison job を
-- 打ち切る・種別ごとの結果テーブルを作らない、の 3 点を変えている。
CREATE TABLE IF NOT EXISTS jobs (
  -- SERIAL (int4): pg ドライバは int8 を string で返すため、フロントの
  -- z.number() と揃えて int4 にする (旧 media_jobs と同じ判断)。
  id           SERIAL      PRIMARY KEY,
  kind         TEXT        NOT NULL,
  -- 同一対象の判定に使う。意味は種別ごとに決める (走査なら connId/bucket/prefix)。
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

CREATE INDEX IF NOT EXISTS jobs_claim
  ON jobs (created_at) WHERE status = 'queued';

-- 「最後に成功したジョブ」を引く用。結果ストアを兼ねる。
CREATE INDEX IF NOT EXISTS jobs_latest
  ON jobs (kind, dedup_key, finished_at DESC) WHERE status = 'done';

ALTER TABLE    jobs        OWNER TO dashboard_rw;
ALTER SEQUENCE jobs_id_seq OWNER TO dashboard_rw;
GRANT SELECT ON jobs TO dashboard_ro;
