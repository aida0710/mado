import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'
import { classify, classifyEntry } from '../lib/api/mime'
import { usePinnedPreviews, type PinnedItem } from '../lib/pinnedPreviews'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewArchive } from './PreviewArchive'

const unsupportedMessage = (
  <p className="text-[13px] text-ink-7">
    プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
  </p>
)

// ピンカード内のテキスト/JSON 表示。単体ファイルは api.textPreview、tar エントリは
// api.tarEntryText を load に渡す。minify された 1 行 JSON でも潰れないよう固定高さ
// (音声カードのスペクトログラム相当) にして縦横スクロールで読ませる。
function PinnedTextBody({ load }: { load: () => Promise<string> }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    load()
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
    // load は呼び出しごとに新しい関数だが、item 由来で安定しているため deps は空でよい
    // (呼び出し側は key={item.id} でカードごと再マウントされる)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) return <p className="error">{error}</p>
  if (text === null) return <p className="text-[13px] text-ink-7">loading…</p>
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
      return <PinnedTextBody load={() => api.tarEntryText(connId, bucket, key, entryPath)} />
    }
    return unsupportedMessage
  }
  const kind = classify(key)
  if (kind === 'text')    return <PinnedTextBody load={() => api.textPreview(connId, bucket, key)} />
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
