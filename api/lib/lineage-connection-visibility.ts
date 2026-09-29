import type { DatasetDetail, StorageLocationDetail } from '../shared/lineage-types.js'

// 接続のホワイトリストで隠した接続は、Lineage の応答でも存在を明かさない。
// 保存場所には Mado の接続 ID が 2 か所に入りうる。Mado が binding から付ける madoConnectionId と、
// 手動登録のときに Registry へ保存した metadata.madoConnectionId。どちらも除く。

/** visibleConnectionIds が null なら全接続が見える (接続の管理者か認証無効)。 */
export function withoutHiddenConnection(
  location: StorageLocationDetail,
  visibleConnectionIds: ReadonlySet<string> | null,
): StorageLocationDetail {
  if (visibleConnectionIds === null) return location
  const isHidden = (value: unknown) => typeof value === 'string' && !visibleConnectionIds.has(value)
  const { madoConnectionId: metadataConnectionId, ...metadataWithoutConnection } = location.metadata
  return {
    ...location,
    madoConnectionId: isHidden(location.madoConnectionId) ? null : location.madoConnectionId,
    metadata: isHidden(metadataConnectionId) ? metadataWithoutConnection : location.metadata,
  }
}

export function datasetWithoutHiddenConnections(
  detail: DatasetDetail,
  visibleConnectionIds: ReadonlySet<string> | null,
): DatasetDetail {
  if (visibleConnectionIds === null) return detail
  return {
    ...detail,
    versions: detail.versions.map(version => ({
      ...version,
      locations: version.locations.map(location => withoutHiddenConnection(location, visibleConnectionIds)),
    })),
  }
}
