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
import { PreviewArchive } from './PreviewArchive'
import { UnsupportedPreview } from './UnsupportedPreview'

// ピンカード内のテキスト/JSON 表示。url は単体ファイルなら api.textPreviewUrl、
// tar エントリなら api.tarEntryUrl。minify された 1 行 JSON でも潰れないよう固定高さ
// (音声カードのスペクトログラム相当) にして縦横スクロールで読ませる。name は拡張子
// 判定用のファイル名 (単体は key、tar エントリは entryPath)。
function PinnedTextBody({ name, url }: { name: string; url: string }) {
  const sniffed = useSniffedText(url)

  if (sniffed.status === 'error') return <p className="error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="text-[13px] text-ink-7">loading…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />

  const display = prettyPrintJson(name, sniffed.text)
  return (
    <pre
      className="m-0 h-[280px] overflow-auto whitespace-pre p-3 text-[12px] leading-snug"
      style={{
        fontFamily: 'var(--font-mono)',
        background: 'var(--ink-0)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius-2)',
        color: 'var(--ink-11)',
      }}
    >
      {display}
    </pre>
  )
}

function PinnedEntryImage({ connId, bucket, archiveKey, entry }: {
  connId: string; bucket: string; archiveKey: string; entry: string
}) {
  return (
    <img
      className="mx-auto block h-auto max-w-full"
      style={{
        borderRadius: 'var(--radius-2)',
        border: '1px solid var(--rule)',
        boxShadow: '0 1px 4px rgba(10, 9, 4, 0.06)',
      }}
      src={api.tarEntryUrl(connId, bucket, archiveKey, entry)}
      alt={entry}
    />
  )
}

function PinnedPreviewBody({ item }: { item: PinnedItem }) {
  const { connId, bucket, key, entryPath } = item
  if (entryPath != null) {
    const kind = classifyEntry(entryPath)
    if (kind === 'audio') {
      return <PreviewAudio connId={connId} bucket={bucket} k={key} entryPath={entryPath} />
    }
    if (kind === 'image') {
      return <PinnedEntryImage connId={connId} bucket={bucket} archiveKey={key} entry={entryPath} />
    }
    // 画像・音声以外はすべてテキスト表示に落とし、中身で判定する。
    // head モードで先頭だけ抽出させる。バイナリエントリのために 100MB を
    // サーバーで解凍させない (レスポンスも 64KB で済む)。
    return (
      <PinnedTextBody
        name={entryPath}
        url={api.tarEntryUrl(connId, bucket, key, entryPath, { maxBytes: TEXT_HEAD_BYTES })}
      />
    )
  }
  // 単体ファイルも同じ。画像・音声・アーカイブ以外はテキスト表示に落とし、中身で判定する。
  const kind = classify(key)
  if (kind === 'image')   return <PreviewImage connId={connId} bucket={bucket} k={key} />
  if (kind === 'audio')   return <PreviewAudio connId={connId} bucket={bucket} k={key} />
  if (kind === 'archive') return <PreviewArchive connId={connId} bucket={bucket} k={key} />
  return <PinnedTextBody name={key} url={api.textPreviewUrl(connId, bucket, key)} />
}

export function PinnedPreviewCard({ item }: { item: PinnedItem }) {
  const { removePin } = usePinnedPreviews()
  const { connId, bucket, key, entryPath } = item
  // ピンカードは <Routes> の外 (BottomDock) に居るので connId を明示して引く。
  const caps = useCapabilities(connId)
  const fullPath = fullEntryLabel(key, entryPath)
  const filename = basename(entryPath ?? key)
  const downloadUrl = entryPath != null
    ? api.tarEntryUrl(connId, bucket, key, entryPath)
    : api.downloadUrl(connId, bucket, key)

  return (
    <div
      className="flex flex-col gap-2 p-3"
      style={{ border: '1px solid var(--rule)', borderRadius: 'var(--radius-2)' }}
    >
      <header className="flex items-center gap-2">
        <CopyablePath
          text={filename}
          fullPath={fullPath}
          className="min-w-0 flex-1 text-[12px] text-ink-11"
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        {/* tar エントリのダウンロードは archive 権限側 (中身の取り出し) が担当する。 */}
        {(entryPath != null ? caps.archive : caps.download) && (
          <a
            className="ghost no-underline"
            href={downloadUrl}
            download={filename}
            aria-label={`${filename} をダウンロード`}
            title="ダウンロード"
          >
            <span aria-hidden>↓</span>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em]">DL</span>
          </a>
        )}
        <button
          type="button"
          className="ghost"
          onClick={() => removePin(item.id)}
          aria-label={`${filename} のピン留めを解除`}
          title="ピン留めを解除"
        >
          <span aria-hidden>✕</span>
        </button>
      </header>
      <div>
        <PinnedPreviewBody item={item} />
      </div>
    </div>
  )
}
