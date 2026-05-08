-- 接続ごとに ListObjects v1 / v2 を選べるようにする。
--
-- 動機: DDN/MDX 互換 S3 (s3ds.mdx.jp 等) は ListObjectsV2 をサポートせず、
-- V2 リクエストでも V1 形式 (<NextMarker>) で応答してしまう。さらに V2 専用の
-- ?start-after= パラメータを認識しないため、何ページ目を要求しても先頭ページが
-- 返る → ページャが事実上機能しない。s3cmd は V1 (?marker=) でアクセスして
-- 正しく動作するので、本ダッシュボードもサーバごとに API バージョンを切り替える。
--
-- 既定値は 'v2' (AWS S3 / Cloudflare R2 / MinIO 等の新しい実装向け)。
-- MDX や古い NetApp StorageGRID 等の V1-only サーバには 'v1' を指定する。

ALTER TABLE storage_connections
  ADD COLUMN IF NOT EXISTS list_objects_version TEXT NOT NULL DEFAULT 'v2'
  CHECK (list_objects_version IN ('v1', 'v2'));
