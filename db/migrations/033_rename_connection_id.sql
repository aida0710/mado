-- 接続 ID の名前を connectionId に統一する。
--
-- コード側は connId と connectionId が混在していたので connectionId へ揃えた。
-- 永続化された形式で connId 系の名前が残るのは次の 2 か所だけなので、ここで揃える。
--   1. storage_response_cache.conn_id 列 (他の表はすべて connection_id)
--   2. jobs.payload の JSON キー connId (storage.scan の投入時に書く)
-- 列名の変更なので、旧 API が稼働中に適用すると cache の read/write が失敗する。
-- cache は失敗しても throw しない設計だが、api-internal の再作成直前に適用すること。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'storage_response_cache' AND column_name = 'conn_id'
  ) THEN
    ALTER TABLE storage_response_cache RENAME COLUMN conn_id TO connection_id;
  END IF;
END $$;

-- queued / running の行は新しい worker が payload.connectionId を読むので変換が要る。
-- 終了済みの行も latestScan の参照で読むため、状態を問わず揃える。
UPDATE jobs
SET payload = (payload - 'connId') || jsonb_build_object('connectionId', payload->'connId')
WHERE payload ? 'connId';
