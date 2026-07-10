import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'
import { classifyEntry } from '../lib/api/mime'
import { fmtSize, prettyPrintJson } from '../lib/format'
import { absoluteUrl, tarEntryWebUrl } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { usePinnedPreviews } from '../lib/pinnedPreviews'
import { useSniffedText } from '../lib/useSniffedText'
import { CopyMenu, type MenuItem } from './CopyMenu'
import { PreviewAudio } from './PreviewAudio'
import { UnsupportedPreview } from './UnsupportedPreview'

interface Props {
  connId: string
  bucket: string
  archiveKey: string
  // size / type は任意。共有 URL (?entry=) から直接開いたエントリは、ページングされた
  // 一覧の今のページに載っているとは限らず、そのときサイズを引く手段がない。
  // 本文は name から自前でフェッチするので、開くのに必要なのは name だけ。
  entry: { name: string; size?: number; type?: string }
  onClose: () => void
}

export function TarEntryModal({ connId, bucket, archiveKey, entry, onClose }: Props) {
  const kind = classifyEntry(entry.name)
  const url = api.tarEntryUrl(connId, bucket, archiveKey, entry.name)
  const { addPin } = usePinnedPreviews()
  // 人に送る用 (このエントリを開いた状態で復元される) と、curl / VLC 用の生データ。
  // どちらもクリップボードに載せるので絶対 URL にする (相対のままだと受け取った
  // 側でホストが分からない)。
  const copyItems: MenuItem[] = [
    {
      kind: 'copy',
      label: 'Web URL をコピー',
      value: absoluteUrl(tarEntryWebUrl(connId, bucket, archiveKey, entry.name)),
    },
    { kind: 'copy', label: '生データ URL をコピー', value: absoluteUrl(url) },
  ]

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
          {entry.size != null && (
            <span
              className="text-[11px] text-ink-7 tabular-nums"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {fmtSize(entry.size)}
            </span>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => addPin({ connId, bucket, key: archiveKey, entryPath: entry.name })}
            aria-label="ピン留め"
            title="ピン留め"
          >
            <span aria-hidden>📌</span>
          </button>
          <CopyMenu items={copyItems} trigger="🔗" ariaLabel="URL をコピー" />
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
          {kind === 'image' && <ImageBody url={url} alt={entry.name} />}
          {kind === 'audio' && (
            <PreviewAudio
              key={`${connId}|${bucket}|${archiveKey}|${entry.name}`}
              connId={connId}
              bucket={bucket}
              k={archiveKey}
              entryPath={entry.name}
            />
          )}
          {/* 画像 / 音声以外はすべてテキストとして開こうとする。
              中身がバイナリなら TextBody が「プレビュー非対応」を出す。 */}
          {kind !== 'image' && kind !== 'audio' && <TextBody url={url} name={entry.name} />}
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

function TextBody({ url, name }: { url: string; name: string }) {
  const sniffed = useSniffedText(url)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)

  if (sniffed.status === 'error') return <p className="error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="text-[13px] text-ink-7">loading…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />

  const display = prettyPrintJson(name, sniffed.text)

  // 末尾の改行で行数が余分に増えないようにする。
  const trimmed = display.endsWith('\n') ? display.slice(0, -1) : display
  const lines = trimmed.length === 0 ? 0 : trimmed.split('\n').length

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
