-- バケット直下のディレクトリ別の容量を、bucket全体のsnapshotと同じ完全走査から保存する。
-- 走査はもともと直下のディレクトリ別にサイズ上位50件を数えているので、S3へのrequestは増えない。
-- 上位50件に入らなかったディレクトリと直下のファイルは保存しない
-- (bucket全体のsnapshotとの差として画面で出す)。

CREATE TABLE IF NOT EXISTS storage_capacity_prefix_snapshots (
  snapshot_id   BIGINT NOT NULL REFERENCES storage_capacity_snapshots(id) ON DELETE CASCADE,
  prefix        TEXT   NOT NULL,
  total_bytes   BIGINT NOT NULL CHECK (total_bytes >= 0),
  object_count  BIGINT NOT NULL CHECK (object_count >= 0),
  PRIMARY KEY (snapshot_id, prefix)
);

-- 既存のsnapshotは、走査jobの結果がまだ残っていれば同じ内訳で埋める。
-- 終了したjobは7日で消えるため、それより古いsnapshotには内訳が付かない。
INSERT INTO storage_capacity_prefix_snapshots (snapshot_id, prefix, total_bytes, object_count)
SELECT snapshot.id, child->>'name', (child->>'totalBytes')::bigint, (child->>'objectCount')::bigint
  FROM storage_capacity_snapshots snapshot
  JOIN jobs job ON job.id = snapshot.job_id
 CROSS JOIN LATERAL jsonb_array_elements(job.result->'children') child
 WHERE jsonb_typeof(job.result->'children') = 'array'
ON CONFLICT (snapshot_id, prefix) DO NOTHING;

ALTER TABLE storage_capacity_prefix_snapshots OWNER TO dashboard_rw;
GRANT SELECT ON storage_capacity_prefix_snapshots TO dashboard_ro;
