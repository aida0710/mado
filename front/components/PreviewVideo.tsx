import { api } from '../lib/api/client'
import { useMediaSrc } from '../lib/useMediaSrc'

interface Props {
  connId: string
  bucket: string
  k: string
  // tar内エントリのとき: k = tarのキー、entryPath = tar内パス
  entryPath?: string
}

export function PreviewVideo({ connId, bucket, k, entryPath }: Props) {
  const directUrl = entryPath ? null : api.videoUrl(connId, bucket, k)
  const archiveEntryUrl = entryPath ? api.tarEntryUrl(connId, bucket, k, entryPath) : null
  const { src, loading, error } = useMediaSrc(directUrl, archiveEntryUrl)
  const label = entryPath ?? k

  return (
    <div className="flex flex-col gap-2">
      {loading && <p className="m-0 text-[12px] text-ink-7">動画を取得中…</p>}
      {error && <p className="m-0 text-[12px] text-ink-7">動画を取得できません: {error}</p>}
      {src && (
        <video
          aria-label={`${label} の動画プレビュー`}
          className="block max-h-[70vh] w-full bg-black"
          src={src}
          controls
          playsInline
          preload="metadata"
        />
      )}
    </div>
  )
}
