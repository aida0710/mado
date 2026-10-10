import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Database } from 'lucide-react'
import { api } from '../../lib/api/client'
import type { StorageLineageResolution } from '../../lib/api/types'

interface Props {
  connectionId: string
  bucket: string
  path: string
}

function lineageHref(namespace: string, name: string): string {
  const query = new URLSearchParams({ namespace, name })
  return `/lineage?${query.toString()}`
}

function versionHref(versionId: string): string {
  const query = new URLSearchParams({ mode: 'versions', versionId })
  return `/lineage?${query.toString()}`
}

function locationRelation(matchType: 'exact' | 'prefix'): string {
  return matchType === 'exact'
    ? 'この場所を保存先として登録済み'
    : '登録済み保存先の配下'
}

export function StorageLineagePanel({ connectionId, bucket, path }: Props) {
  const requestKey = `${connectionId}\u0000${bucket}\u0000${path}`
  const [response, setResponse] = useState<{
    key: string
    resolution: StorageLineageResolution | null
  } | null>(null)

  useEffect(() => {
    let current = true
    api.lineageResolveLocation(connectionId, bucket, path).then(
      value => { if (current) setResponse({ key: requestKey, resolution: value }) },
      () => { if (current) setResponse({ key: requestKey, resolution: null }) },
    )
    return () => { current = false }
  }, [connectionId, bucket, path, requestKey])

  const resolution = response?.key === requestKey ? response.resolution : null

  if (!resolution || resolution.matches.length === 0) return null

  // .notice に近い区画 (左の線 + 淡い地)。README の補足として、その直後に置かれる。
  return (
    <aside className="storage-lineage" aria-label="この保存場所に関連するデータセット">
      <span className="storage-lineage-label">
        <Database size={14} aria-hidden="true" />
        データセット
      </span>
      <div className="storage-lineage-matches">
        {resolution.matches.slice(0, 3).map(match => (
          <div className="storage-lineage-match" key={`${match.versionId}:${match.locationId}`}>
            <div className="storage-lineage-name">
              <strong>{match.displayName ?? match.name}</strong>
              <span className="muted">
                {locationRelation(match.matchType)}
                {match.versionCount > 1 ? ` · バージョン ${match.version}` : ''}
              </span>
            </div>
            <div className="storage-lineage-actions">
              <Link className="link-button" to={versionHref(match.versionId)}>処理の流れを見る</Link>
              <Link className="link-button" to={lineageHref(match.namespace, match.name)}>データセット全体を見る</Link>
            </div>
          </div>
        ))}
        {resolution.matches.length > 3 && (
          <span className="muted">他{resolution.matches.length - 3}件</span>
        )}
      </div>
    </aside>
  )
}
