import { classify } from '../api/mime'
import { PreviewText } from './PreviewText'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewArchive } from './PreviewArchive'

interface Props {
  bucket: string
  k: string | null
  onClose: () => void
}

export function PreviewDrawer({ bucket, k, onClose }: Props) {
  if (!k) return null
  const kind = classify(k)
  return (
    <aside className="drawer">
      <header className="drawer__head">
        <h4 className="drawer__title">{k}</h4>
        <button className="ghost" onClick={onClose} aria-label="Close preview">✕</button>
      </header>
      <div className="drawer__body">
        {kind === 'text' && <PreviewText bucket={bucket} k={k} />}
        {kind === 'image' && <PreviewImage bucket={bucket} k={k} />}
        {kind === 'audio' && <PreviewAudio bucket={bucket} k={k} />}
        {kind === 'archive' && <PreviewArchive bucket={bucket} k={k} />}
        {kind === 'unknown' && (
          <p className="muted">
            プレビュー非対応のファイル種別です。
          </p>
        )}
      </div>
    </aside>
  )
}
