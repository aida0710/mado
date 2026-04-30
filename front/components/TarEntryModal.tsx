import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { classifyEntry } from '../api/mime'
import { fmtSize } from '../lib/format'

interface Props {
  bucket: string
  archiveKey: string
  entry: { name: string; size: number; type: string }
  onClose: () => void
}

export function TarEntryModal({ bucket, archiveKey, entry, onClose }: Props) {
  const kind = classifyEntry(entry.name)
  const url = api.tarEntryUrl(bucket, archiveKey, entry.name)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop modal-backdrop--entry"
      onClick={onClose}
    >
      <div
        className="modal modal--entry"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tar-entry-title"
      >
        <header className="modal__head">
          <p className="modal__breadcrumb" id="tar-entry-title">
            <span className="muted">{archiveKey}</span>
            <span className="muted breadcrumb__sep">/</span>
            <span>{entry.name}</span>
          </p>
          <span className="muted--small tabular">{fmtSize(entry.size)}</span>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close entry"
          >
            ✕
          </button>
        </header>
        <div className="modal__body">
          {kind === 'image'   && <ImageBody url={url} alt={entry.name} />}
          {kind === 'audio'   && <AudioBody url={url} />}
          {kind === 'text'    && <TextBody bucket={bucket} archiveKey={archiveKey} entry={entry.name} />}
          {kind === 'unknown' && <UnknownBody url={url} name={entry.name} />}
        </div>
      </div>
    </div>
  )
}

function ImageBody({ url, alt }: { url: string; alt: string }) {
  return <img className="entry-img" src={url} alt={alt} />
}

function AudioBody({ url }: { url: string }) {
  return <audio className="entry-audio" src={url} controls preload="metadata" />
}

function TextBody({
  bucket, archiveKey, entry,
}: { bucket: string; archiveKey: string; entry: string }) {
  const [text, setText] = useState<string>('loading…')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.tarEntryText(bucket, archiveKey, entry)
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [bucket, archiveKey, entry])
  if (error) return <p className="error">{error}</p>
  // Pretty-print JSON if it parses cleanly.
  let display = text
  if (entry.toLowerCase().endsWith('.json')) {
    try { display = JSON.stringify(JSON.parse(text), null, 2) } catch { /* leave raw */ }
  }
  return <pre className="entry-text">{display}</pre>
}

function UnknownBody({ url, name }: { url: string; name: string }) {
  return (
    <div className="entry-unknown">
      <p className="muted">プレビュー非対応のファイル種別です。</p>
      <a className="ghost" href={url} download={name.split('/').pop()}>
        ダウンロード
      </a>
    </div>
  )
}
