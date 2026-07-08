-- データセットスキャン機能の削除に伴い、ジョブキューと統計テーブルを落とす。
-- media_cache は単体ファイルの波形/スペクトログラム解析が使うため残す。
DROP TABLE IF EXISTS media_jobs;
DROP TABLE IF EXISTS dataset_stats;
