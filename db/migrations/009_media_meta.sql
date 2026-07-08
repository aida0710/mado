-- 音声解析の詳細メタ情報 (コーデック/チャンネル数/ビット深度/ビットレート/
-- サイズ/音量) を追加 (spec: 2026-07-08-audio-info-display-design.md)。
-- 既存行は meta IS NULL のままなので、getCachedMedia がこれをキャッシュミス
-- 扱いにすることで次回アクセス時に自然に再解析されバックフィルされる。
ALTER TABLE media_cache ADD COLUMN IF NOT EXISTS meta jsonb;
