import { api } from '../lib/api/client'
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
  const filename = k.split('/').pop() ?? 'file'
  return (
    <aside className="drawer">
      <header className="drawer__head">
        <p className="drawer__title">{k}</p>
        <a
          className="ghost no-underline"
          href={api.downloadUrl(connId, bucket, k)}
          download={filename}
          aria-label={`${filename} をダウンロード`}
          title="ダウンロード"
        >
          <span aria-hidden>↓</span>
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em]">DL</span>
        </a>
        <button
          className="ghost"
          onClick={onClose}
          aria-label="Close preview"
          title="閉じる"
        >
          <span aria-hidden>✕</span>
        </button>
      </header>
      <div className="drawer__body">
        {kind === 'text' && <PreviewText connId={connId} bucket={bucket} k={k} />}
        {kind === 'image' && <PreviewImage connId={connId} bucket={bucket} k={k} />}
        {kind === 'audio' && <PreviewAudio connId={connId} bucket={bucket} k={k} />}
        {kind === 'archive' && <PreviewArchive connId={connId} bucket={bucket} k={k} />}
        {kind === 'unknown' && (
          <p className="text-[13px] text-ink-7">
            プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
          </p>
        )}
      </div>
    </aside>
  )
}
