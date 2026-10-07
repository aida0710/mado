-- 所有接続が分からない旧キャッシュは再計算し、別接続の画像を返さない。
ALTER TABLE media_cache ADD COLUMN IF NOT EXISTS connection_id TEXT;
