-- バケット単位の設定を廃止し、接続単位 (connection_settings) に移す。
-- scan_enabled / list_cache_ttl_sec は connection_settings のキーになった。
--
-- 接続単位にすると getConnectionConfig のキャッシュ (S3Client と同じ 1 行) に
-- 相乗りできるので、/list のたびに設定を引く DB アクセスが不要になる。
DROP TABLE IF EXISTS bucket_settings;
