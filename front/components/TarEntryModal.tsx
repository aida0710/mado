import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'
import { classifyEntry } from '../lib/api/mime'
import { fmtSize } from '../lib/format'
import { copyToClipboard } from '../lib/clipboard'

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
    <div className="modal-backdrop modal-backdrop--entry" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        onClick={onClose}
        aria-label="モーダルを閉じる"
        tabIndex={-1}
      />
      <div
        className="modal modal--entry"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tar-entry-title"
      >
        <header
          className="flex flex-wrap items-center gap-3 pb-3 mb-3"
          style={{ borderBottom: '1px solid var(--rule)' }}
        >
          <p
            id="tar-entry-title"
            className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-1"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          >
            <span className="text-ink-7 truncate">{archiveKey}</span>
            <span className="text-ink-3 px-[2px]" style={{ fontFamily: 'var(--font-serif)' }}>›</span>
            <span className="text-ink-12">{entry.name}</span>
          </p>
          <span
            className="text-[11px] text-ink-7 tabular-nums"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {fmtSize(entry.size)}
          </span>
          <a
            className="ghost no-underline"
            href={url}
            download={entry.name.split('/').pop()}
            aria-label={`${entry.name} をダウンロード`}
            title="ダウンロード"
          >
            <span aria-hidden>↓</span>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em]">DL</span>
          </a>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close entry"
          >
            <span aria-hidden>✕</span>
          </button>
        </header>
        <div className="overflow-auto">
          {kind === 'image'   && <ImageBody url={url} alt={entry.name} />}
          {kind === 'audio'   && <AudioBody url={url} />}
          {kind === 'text'    && <TextBody connId={connId} bucket={bucket} archiveKey={archiveKey} entry={entry.name} />}
          {kind === 'unknown' && <UnknownBody />}
        </div>
      </div>
    </div>
  )
}

function ImageBody({ url, alt }: { url: string; alt: string }) {
  return (
    <img
      className="mx-auto block h-auto max-w-full"
      style={{
        borderRadius: 'var(--radius-2)',
        border: '1px solid var(--rule)',
        boxShadow: '0 1px 4px rgba(10, 9, 4, 0.06)',
      }}
      src={url}
      alt={alt}
    />
  )
}

function AudioBody({ url }: { url: string }) {
  return <audio className="w-full" src={url} controls preload="metadata" />
}

function TextBody({
  connId, bucket, archiveKey, entry,
}: { connId: string; bucket: string; archiveKey: string; entry: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.tarEntryText(connId, bucket, archiveKey, entry)
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [connId, bucket, archiveKey, entry])

  if (error) return <p className="error">{error}</p>
  if (text === null) {
    return <p className="text-[13px] text-ink-7">loading…</p>
  }

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

  // 表示中の内容 (display: .json は整形済) をまるごとクリップボードへ。
  const handleCopy = async () => {
    const ok = await copyToClipboard(display)
    setCopyMsg(ok ? 'コピーしました ✓' : 'コピー失敗')
    setTimeout(() => setCopyMsg(null), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[11px] text-ink-7 tabular-nums"
          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
        >
          {lines} 行
        </span>
        <button
          type="button"
          className="ghost text-[11px]"
          onClick={handleCopy}
          title="内容をコピー"
          aria-label="内容をコピー"
        >
          {copyMsg ?? '内容をコピー'}
        </button>
      </div>
      <pre
        className="m-0 max-h-[70vh] overflow-auto whitespace-pre p-3 text-[12px] leading-snug"
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
    </div>
  )
}

function UnknownBody() {
  // ダウンロードはヘッダの DL ボタンに集約済。
  return (
    <p className="text-[13px] text-ink-7">
      プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
    </p>
  )
}
