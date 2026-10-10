import { Download, X } from 'lucide-react'
import { api } from '../lib/api/client'
import { classify, classifyEntry } from '../lib/api/mime'
import { basename, fullEntryLabel, prettyPrintJson } from '../lib/format'
import { TEXT_HEAD_BYTES } from '../lib/textSniff'
import { useSniffedText } from '../lib/useSniffedText'
import { usePinnedPreviews, type PinnedItem } from '../lib/pinnedPreviews'
import { useCapabilities } from '../lib/useCapabilities'
import { CopyablePath } from './CopyablePath'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewVideo } from './PreviewVideo'
import { PreviewArchive } from './PreviewArchive'
import { UnsupportedPreview } from './UnsupportedPreview'

// ピンカード内のテキスト/JSON 表示。url は単体ファイルなら api.textPreviewUrl、
// tar エントリなら api.tarEntryUrl。minify された 1 行 JSON でも潰れないよう固定高さ
// (音声カードのスペクトログラム相当) にして縦横スクロールで読ませる。name は拡張子
// 判定用のファイル名 (単体は key、tar エントリは entryPath)。
function PinnedTextBody({ name, url }: { name: string; url: string }) {
  const sniffed = useSniffedText(url)

  if (sniffed.status === 'error') return <p className="notice error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="muted">読み込み中…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />

  return <pre className="preview-code pinned-text">{prettyPrintJson(name, sniffed.text)}</pre>
}

function PinnedPreviewBody({ item }: { item: PinnedItem }) {
  const { connectionId, bucket, key, entryPath } = item
  if (entryPath != null) {
    const kind = classifyEntry(entryPath)
    if (kind === 'audio') {
      return <PreviewAudio connectionId={connectionId} bucket={bucket} k={key} entryPath={entryPath} />
    }
    if (kind === 'image') {
      return (
        <img
          className="preview-image"
          src={api.tarEntryUrl({ connectionId, bucket, key, entry: entryPath })}
          alt={entryPath}
        />
      )
    }
    if (kind === 'video') {
      return <PreviewVideo connectionId={connectionId} bucket={bucket} k={key} entryPath={entryPath} />
    }
    // 画像・音声・動画以外はすべてテキスト表示に落とし、中身で判定する。
    // head モードで先頭だけ抽出させる。バイナリエントリのために 100MB を
    // サーバーで解凍させない (レスポンスも 64KB で済む)。
    return (
      <PinnedTextBody
        name={entryPath}
        url={api.tarEntryUrl({ connectionId, bucket, key, entry: entryPath, maxBytes: TEXT_HEAD_BYTES })}
      />
    )
  }
  // 単体ファイルも同じ。画像・音声・アーカイブ以外はテキスト表示に落とし、中身で判定する。
  const kind = classify(key)
  if (kind === 'image')   return <PreviewImage connectionId={connectionId} bucket={bucket} k={key} />
  if (kind === 'audio')   return <PreviewAudio connectionId={connectionId} bucket={bucket} k={key} />
  if (kind === 'video')   return <PreviewVideo connectionId={connectionId} bucket={bucket} k={key} />
  if (kind === 'archive') return <PreviewArchive connectionId={connectionId} bucket={bucket} k={key} />
  return <PinnedTextBody name={key} url={api.textPreviewUrl(connectionId, bucket, key)} />
}

/** 画面下のドックに並べる、ピン留めしたプレビューのカード。上の帯にファイル名と操作。 */
export function PinnedPreviewCard({ item }: { item: PinnedItem }) {
  const { removePin } = usePinnedPreviews()
  const { connectionId, bucket, key, entryPath } = item
  // ピンカードは <Routes> の外 (BottomDock) に居るので connectionId を明示して引く。
  const caps = useCapabilities(connectionId)
  const fullPath = fullEntryLabel(key, entryPath)
  const filename = basename(entryPath ?? key)
  const downloadUrl = entryPath != null
    ? api.tarEntryUrl({ connectionId, bucket, key, entry: entryPath })
    : api.downloadUrl(connectionId, bucket, key)

  return (
    <div className="pinned-card">
      <header className="pinned-card-header">
        <CopyablePath text={filename} fullPath={fullPath} />
        {/* tar エントリのダウンロードは archive 権限側 (中身の取り出し) が担当する。 */}
        {(entryPath != null ? caps.archive : caps.download) && (
          <a
            className="icon-button"
            href={downloadUrl}
            download={filename}
            aria-label={`${filename} をダウンロード`}
            title="ダウンロード"
          >
            <Download size={16} aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          className="icon-button"
          onClick={() => removePin(item.id)}
          aria-label={`${filename} のピン留めを解除`}
          title="ピン留めを解除"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="pinned-card-body">
        <PinnedPreviewBody item={item} />
      </div>
    </div>
  )
}
