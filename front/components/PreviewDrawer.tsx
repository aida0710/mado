import { classify } from '../lib/api/mime'
import { PreviewText } from './PreviewText'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewArchive } from './PreviewArchive'

interface Props {
  connId: string
  bucket: string
  k: string | null
  onClose: () => void
}

export function PreviewDrawer({ connId, bucket, k, onClose }: Props) {
  if (!k) return null
  const kind = classify(k)
  return (
    <aside className="drawer">
      <header className="drawer__head">
        <p className="drawer__title">{k}</p>
        <button className="ghost" onClick={onClose} aria-label="Close preview">✕</button>
      </header>
      <div className="drawer__body">
        {kind === 'text' && <PreviewText connId={connId} bucket={bucket} k={k} />}
        {kind === 'image' && <PreviewImage connId={connId} bucket={bucket} k={k} />}
        {kind === 'audio' && <PreviewAudio connId={connId} bucket={bucket} k={k} />}
        {kind === 'archive' && <PreviewArchive connId={connId} bucket={bucket} k={k} />}
        {kind === 'unknown' && (
          <p className="text-ink-7">
            プレビュー非対応のファイル種別です。
          </p>
        )}
      </div>
    </aside>
  )
}
