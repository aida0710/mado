// バケット単位の設定 (spec: 2026-08-18-directory-scan-design.md)。
// 設定は app_settings (全体) → connection_settings (接続ごと) →
// bucket_settings (バケットごと) の 3 階層で、ここは最も細かい層。

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api/client'

interface Props {
  connId: string
  bucket: string
}

export function BucketSettingsPanel({ connId, bucket }: Props) {
  const [scanEnabled, setScanEnabled] = useState(true)
  const [ttlSec, setTtlSec] = useState(86400)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.bucketSettings(connId, bucket)
      .then(s => {
        if (cancelled) return
        setScanEnabled(s.scanEnabled)
        setTtlSec(s.listCacheTtlSec)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [connId, bucket])

  const toggleScan = useCallback(() => {
    setScanEnabled(prev => {
      const next = !prev
      api.setBucketSetting(connId, bucket, 'scan_enabled', String(next)).catch(() => {})
      return next
    })
  }, [connId, bucket])

  const saveTtl = useCallback(() => {
    if (ttlSec > 0) {
      api.setBucketSetting(connId, bucket, 'list_cache_ttl_sec', String(ttlSec)).catch(() => {})
    }
  }, [connId, bucket, ttlSec])

  if (!loaded) return null

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={scanEnabled} onChange={toggleScan} />
        走査を許可する
      </label>
      <label className="flex items-center gap-2">
        一覧キャッシュの保持
        <input
          type="number"
          min={1}
          value={ttlSec}
          className="w-24"
          onChange={e => setTtlSec(Number(e.target.value))}
          onBlur={saveTtl}
        />
        秒
      </label>
    </div>
  )
}
