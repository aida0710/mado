import { api } from '../lib/api/client'
import { useMediaSrc } from '../lib/useMediaSrc'

interface Props {
  connectionId: string
  bucket: string
  k: string
  // tar内エントリのとき: k = tarのキー、entryPath = tar内パス
  entryPath?: string
}

export function PreviewVideo({ connectionId, bucket, k, entryPath }: Props) {
  const directUrl = entryPath ? null : api.videoUrl(connectionId, bucket, k)
  const archiveEntryUrl = entryPath ? api.tarEntryUrl({ connectionId, bucket, key: k, entry: entryPath }) : null
  const { src, loading, error } = useMediaSrc({ directUrl, archiveEntryUrl, archiveKey: k })
  const label = entryPath ?? k

  return (
    <div className="preview-stack">
      {loading && <p className="muted">動画を取得中…</p>}
      {error && <p className="notice error">動画を取得できません: {error}</p>}
      {src && (
        <video
          aria-label={`${label} の動画プレビュー`}
          className="preview-video"
          src={src}
          controls
          playsInline
          preload="metadata"
        />
      )}
    </div>
  )
}
