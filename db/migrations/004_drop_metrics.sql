-- メトリクス機能と feature_flags テーブルを drop する。
-- 機能はリポジトリから完全に削除済 (api/external、metrics push、Metrics タブ等)。
-- 001_init.sql からも対応する CREATE 文を削除済なので、新規構築では最初から作られない。
-- 既存の本番 DB に対してはこの migration が走って物理削除する。

DROP VIEW     IF EXISTS metrics_latest;
DROP TABLE    IF EXISTS metrics CASCADE;
DROP TABLE    IF EXISTS feature_flags;
