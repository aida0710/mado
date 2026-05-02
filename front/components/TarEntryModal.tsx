import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'
import { classifyEntry } from '../lib/api/mime'
import { fmtSize } from '../lib/format'

interface Props {
  connId: string
  bucket: string
  archiveKey: string
  entry: { name: string; size: number; type: string }
  onClose: () => void
}

export function TarEntryModal({ connId, bucket, archiveKey, entry, onClose }: Props) {
  const kind = classifyEntry(entry.name)
  const url = api.tarEntryUrl(connId, bucket, archiveKey, entry.name)

  // Escape で閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop modal-backdrop--entry" onClick={onClose}>
      <div
        className="modal modal--entry"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tar-entry-title"
      >
        <header className="flex flex-wrap items-center gap-3 pb-3">
          <p
            id="tar-entry-title"
            className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-1"
          >
            <span className="text-ink-7 truncate">{archiveKey}</span>
            <span className="text-ink-3 px-[2px]">/</span>
            <span>{entry.name}</span>
          </p>
          <span className="text-xs text-ink-7 tabular-nums">{fmtSize(entry.size)}</span>
          <a
            className="ghost no-underline"
            href={url}
            download={entry.name.split('/').pop()}
            aria-label={`${entry.name} をダウンロード`}
            title="ダウンロード"
          >
            ⬇ DL
          </a>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close entry"
          >
            ✕
          </button>
        </header>
        <div className="overflow-auto">
          {kind === 'image'   && <ImageBody url={url} alt={entry.name} />}
          {kind === 'audio'   && <AudioBody url={url} />}
          {kind === 'text'    && <TextBody connId={connId} bucket={bucket} archiveKey={archiveKey} entry={entry.name} />}
          {kind === 'unknown' && <UnknownBody url={url} name={entry.name} />}
        </div>
      </div>
    </div>
  )
}

function ImageBody({ url, alt }: { url: string; alt: string }) {
  return <img className="mx-auto block h-auto max-w-full rounded-2" src={url} alt={alt} />
}

function AudioBody({ url }: { url: string }) {
  return <audio className="w-full" src={url} controls preload="metadata" />
}

function TextBody({
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
  if (text === null) return <p className="text-ink-7">loading…</p>

  // .json (単一ドキュメント) はプリティプリントする。.jsonl / .ndjson は
  // 1行1JSON値の形式なのでそのまま表示する。
  let display = text
  const lower = entry.toLowerCase()
  if (lower.endsWith('.json') && !lower.endsWith('.jsonl')) {
    try {
      display = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      /* そのまま表示 */
    }
  }

  // 末尾の改行で行数が余分に増えないようにする。
  const trimmed = display.endsWith('\n') ? display.slice(0, -1) : display
  const lines = trimmed.length === 0 ? 0 : trimmed.split('\n').length

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-ink-7 tabular-nums">
        <span>{lines} 行</span>
      </p>
      <pre className="m-0 max-h-[70vh] overflow-auto whitespace-pre rounded-2 border border-ink-2 bg-ink-0 p-2 text-xs leading-snug">
        {display}
      </pre>
    </div>
  )
}

function UnknownBody({ url: _url, name: _name }: { url: string; name: string }) {
  // ダウンロードはヘッダの DL ボタンに集約済。
  return (
    <p className="text-ink-7">
      プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
    </p>
  )
}
