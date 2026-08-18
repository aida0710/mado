-- /list と /buckets の応答キャッシュ (spec: 2026-08-18-server-side-list-cache-design.md)
--
-- mdx の dataset バケット (547,259 キー) は Delimiter 付き ListObjects に 35 秒
-- かかる。s3cmd でも同じ時間なのでアプリ側に改善余地はなく、応答を共有して
-- 「誰か一人が開けば全員速い」状態にするのがこのテーブルの目的。
--
-- cache_key は sha256(JSON([kind,connId,bucket,prefix,recursive,cursor])) の hex。
-- conn_id / bucket / prefix を別カラムでも持つのは、1 つの prefix が cursor 違いで
-- 複数行になるため。prefix 単位の無効化にはカラムでの絞り込みが要る。
CREATE TABLE IF NOT EXISTS storage_response_cache (
  cache_key  TEXT PRIMARY KEY,
  conn_id    TEXT NOT NULL,
  bucket     TEXT NOT NULL DEFAULT '',
  prefix     TEXT NOT NULL DEFAULT '',
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS storage_response_cache_scope
  ON storage_response_cache (conn_id, bucket, prefix);
CREATE INDEX IF NOT EXISTS storage_response_cache_expires
  ON storage_response_cache (expires_at);

ALTER TABLE storage_response_cache OWNER TO dashboard_rw;
GRANT SELECT ON storage_response_cache TO dashboard_ro;
