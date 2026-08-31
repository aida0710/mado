import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api/client'
import type { StorageLineageResolution } from '../../lib/api/types'

interface Props {
  connId: string
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

export function StorageLineagePanel({ connId, bucket, path }: Props) {
  const requestKey = `${connId}\u0000${bucket}\u0000${path}`
  const [response, setResponse] = useState<{
    key: string
    resolution: StorageLineageResolution | null
  } | null>(null)

  useEffect(() => {
    let current = true
    api.lineageResolveLocation(connId, bucket, path).then(
      value => { if (current) setResponse({ key: requestKey, resolution: value }) },
      () => { if (current) setResponse({ key: requestKey, resolution: null }) },
    )
    return () => { current = false }
  }, [connId, bucket, path, requestKey])

  const resolution = response?.key === requestKey ? response.resolution : null

  if (!resolution || resolution.matches.length === 0) return null

  return (
    <aside className="storage-lineage" aria-label="この保存場所に関連するDataset">
      <span className="storage-lineage__label">Dataset</span>
      <div className="storage-lineage__matches">
        {resolution.matches.slice(0, 3).map(match => (
          <div className="storage-lineage__match" key={`${match.versionId}:${match.locationId}`}>
            <div>
              <strong>{match.displayName ?? match.name}</strong>
              <span>
                {locationRelation(match.matchType)}
                {match.versionCount > 1 ? ` · バージョン ${match.version}` : ''}
              </span>
            </div>
            <div className="storage-lineage__actions">
              <Link to={versionHref(match.versionId)}>処理の流れを見る</Link>
              <Link to={lineageHref(match.namespace, match.name)}>データセット全体を見る</Link>
            </div>
          </div>
        ))}
      </div>
      {resolution.matches.length > 3 && (
        <span className="storage-lineage__more">他{resolution.matches.length - 3}件</span>
      )}
    </aside>
  )
}
