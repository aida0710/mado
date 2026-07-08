import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'
import { classify, classifyEntry } from '../lib/api/mime'
import { usePinnedPreviews, type PinnedItem } from '../lib/pinnedPreviews'
import { PreviewText } from './PreviewText'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewArchive } from './PreviewArchive'

const unsupportedMessage = (
  <p className="text-[13px] text-ink-7">
    プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
  </p>
)

// tar 内エントリの text/json 向け軽量表示。TarEntryModal の本体表示 (TextBody) から
// コピー / JSON pretty-print を省いた最小版 — ピン留めは複数枚同時に並ぶため、
// 各カードは要点 (中身が読めること) だけに絞る。
function PinnedEntryText({
  connId, bucket, archiveKey, entry,
}: { connId: string; bucket: string; archiveKey: string; entry: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.tarEntryText(connId, bucket, archiveKey, entry)
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [connId, bucket, archiveKey, entry])

  if (error) return <p className="error">{error}</p>
  if (text === null) return <p className="text-[13px] text-ink-7">loading…</p>
  return (
    <pre
      className="m-0 max-h-[40vh] overflow-auto whitespace-pre p-3 text-[12px] leading-snug"
      style={{
        fontFamily: 'var(--font-mono)',
        background: 'var(--ink-0)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius-2)',
        color: 'var(--ink-11)',
      }}
    >
      {text}
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
    if (kind === 'text') {
      return <PinnedEntryText connId={connId} bucket={bucket} archiveKey={key} entry={entryPath} />
    }
    return unsupportedMessage
  }
  const kind = classify(key)
  if (kind === 'text')    return <PreviewText connId={connId} bucket={bucket} k={key} />
  if (kind === 'image')   return <PreviewImage connId={connId} bucket={bucket} k={key} />
  if (kind === 'audio')   return <PreviewAudio connId={connId} bucket={bucket} k={key} />
  if (kind === 'archive') return <PreviewArchive connId={connId} bucket={bucket} k={key} />
  return unsupportedMessage
}

export function PinnedPreviewCard({ item }: { item: PinnedItem }) {
  const { removePin } = usePinnedPreviews()
  const { connId, bucket, key, entryPath } = item
  const fullPath = entryPath != null ? `${key} › ${entryPath}` : key
  const filename = (entryPath ?? key).split('/').pop() ?? key
  const downloadUrl = entryPath != null
    ? api.tarEntryUrl(connId, bucket, key, entryPath)
    : api.downloadUrl(connId, bucket, key)

  return (
    <div
      className="flex flex-col gap-2 p-3"
      style={{ border: '1px solid var(--rule)', borderRadius: 'var(--radius-2)' }}
    >
      <header className="flex items-center gap-2">
        <p
          className="m-0 min-w-0 flex-1 truncate text-[12px] text-ink-11"
          title={fullPath}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {filename}
        </p>
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
