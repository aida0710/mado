import { useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { api } from '../lib/api/client'
import { fmtSize } from '../lib/format'

interface Props {
  connId: string
  bucket: string
  prefix: string
  // README が現在も S3 に存在するなら現在の本文を渡す。履歴と並べて diff 風に
  // 比較するヒントとして使う (今は単純に "現在" マーカーとして表示)。
  currentBody: string | null
  onClose: () => void
}

interface Version {
  id: number
  editor: string
  edited_at: string
  size_bytes: number
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function ReadmeHistoryModal({ connId, bucket, prefix, currentBody, onClose }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [bodyOf, setBodyOf] = useState<{ id: number; body: string } | null>(null)

  useEffect(() => {
    api.readmeHistory(connId, bucket, prefix)
      .then(r => {
        setVersions(r.versions)
        // 最新版を初期選択
        if (r.versions.length > 0) setSelectedId(r.versions[0].id)
      })
      .catch((e: Error) => setError(e.message))
  }, [connId, bucket, prefix])

  useEffect(() => {
    if (selectedId == null) return
    setBodyOf(null)
    api.readmeHistoryVersion(connId, selectedId)
      .then(r => setBodyOf({ id: r.id, body: r.body }))
      .catch((e: Error) => setError(e.message))
  }, [connId, selectedId])

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
        aria-labelledby="readme-history-title"
        data-color-mode="light"
      >
        <header className="flex items-center gap-3 pb-3">
          <h3 id="readme-history-title" className="m-0 flex-1">
            README 履歴 — {prefix || '(root)'}
          </h3>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="履歴を閉じる"
          >
            ✕
          </button>
        </header>

        {error && <p className="error">{error}</p>}
        {!error && versions === null && <p className="text-ink-7">loading…</p>}
        {!error && versions !== null && versions.length === 0 && (
          <p className="text-ink-7">履歴はありません。</p>
        )}

        {versions !== null && versions.length > 0 && (
          <div className="grid gap-4 [grid-template-columns:240px_1fr] min-h-[60vh]">
            <ul className="m-0 list-none overflow-auto p-0">
              {versions.map((v, i) => (
                <li key={v.id} className="border-b border-ink-1">
                  <button
                    type="button"
                    className={
                      'block w-full cursor-pointer border-0 bg-transparent px-2 py-2 text-left transition-colors hover:bg-ink-1 ' +
                      (selectedId === v.id ? 'bg-ink-1 font-semibold ' : '')
                    }
                    onClick={() => setSelectedId(v.id)}
                  >
                    <div className="text-sm">
                      {i === 0 ? '★ ' : ''}{v.editor}
                    </div>
                    <div className="text-[11px] text-ink-7 tabular-nums">
                      {fmtTime(v.edited_at)} · {fmtSize(v.size_bytes)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="overflow-auto">
              {bodyOf === null && <p className="text-ink-7">loading…</p>}
              {bodyOf !== null && (
                <>
                  {currentBody !== null && bodyOf.body === currentBody && (
                    <p className="m-0 mb-2 text-xs text-ink-7">この版は現在の本文と一致します。</p>
                  )}
                  <MDEditor.Markdown
                    source={bodyOf.body}
                    rehypePlugins={[[rehypeSanitize]]}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
