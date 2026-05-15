import { useEffect, useReducer } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { api } from '../lib/api/client'
import { fmtSize } from '../lib/format'

interface Props {
  slug: string
  // 現在の本文 (一致版を強調表示)。null = 現在 note なし。
  currentBody: string | null
  onClose: () => void
}

interface Version {
  id: number
  editor: string
  edited_at: string
  size_bytes: number
}

interface State {
  versions: Version[] | null
  error: string | null
  selectedId: number | null
  bodyOf: { id: number; body: string } | null
}

type Action =
  | { type: 'versionsLoaded'; versions: Version[] }
  | { type: 'selectVersion'; id: number }
  | { type: 'bodyLoaded'; body: { id: number; body: string } }
  | { type: 'fail'; error: string }

const initial: State = { versions: null, error: null, selectedId: null, bodyOf: null }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'versionsLoaded':
      return {
        ...s,
        versions: a.versions,
        selectedId: a.versions.length > 0 ? a.versions[0].id : null,
      }
    case 'selectVersion':
      return { ...s, selectedId: a.id, bodyOf: null }
    case 'bodyLoaded':
      return { ...s, bodyOf: a.body }
    case 'fail':
      return { ...s, error: a.error }
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// Team note (postgres notes テーブル) の編集履歴モーダル。S3 README 用の
// ReadmeHistoryModal と同じ UX。識別タイトルで「Team note」を明示する。
export function NoteHistoryModal({ slug, currentBody, onClose }: Props) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { versions, error, selectedId, bodyOf } = state

  useEffect(() => {
    api.noteHistory(slug)
      .then(r => dispatch({ type: 'versionsLoaded', versions: r.versions }))
      .catch((e: Error) => dispatch({ type: 'fail', error: e.message }))
  }, [slug])

  useEffect(() => {
    if (selectedId == null) return
    api.noteHistoryVersion(slug, selectedId)
      .then(r => dispatch({ type: 'bodyLoaded', body: { id: r.id, body: r.body } }))
      .catch((e: Error) => dispatch({ type: 'fail', error: e.message }))
  }, [slug, selectedId])

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
        aria-labelledby="note-history-title"
        data-color-mode="light"
      >
        <header className="flex items-baseline gap-3 pb-4 mb-2" style={{ borderBottom: '1px solid var(--rule)' }}>
          <div className="flex-1 min-w-0">
            <p className="kicker">Team note · 履歴</p>
            <h3 id="note-history-title" className="m-0 truncate">
              {slug}
            </h3>
          </div>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="履歴を閉じる"
          >
            <span aria-hidden>✕</span>
          </button>
        </header>

        {error && <p className="error">{error}</p>}
        {!error && versions === null && (
          <p className="text-[13px] text-ink-7">loading…</p>
        )}
        {!error && versions !== null && versions.length === 0 && (
          <p className="text-[13px] text-ink-7">履歴はありません。</p>
        )}

        {versions !== null && versions.length > 0 && (
          <div className="grid gap-4 md:gap-5 grid-cols-1 md:[grid-template-columns:240px_1fr] min-h-[60vh]">
            <ul
              className="m-0 list-none overflow-auto p-0 max-h-[40vh] md:max-h-none border-b md:border-b-0 md:[border-right:1px_solid_var(--rule)]"
              style={{ borderColor: 'var(--rule)' }}
            >
              {versions.map((v, i) => {
                const selected = selectedId === v.id
                return (
                  <li key={v.id} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <button
                      type="button"
                      className={
                        'block w-full cursor-pointer border-0 bg-transparent py-2.5 pr-3 pl-3 text-left ' +
                        'transition-colors hover:bg-ink-0 ' +
                        (selected ? 'bg-ink-0 ' : '')
                      }
                      style={selected ? { borderLeft: '2px solid var(--ink-12)', paddingLeft: '10px' } : undefined}
                      onClick={() => dispatch({ type: 'selectVersion', id: v.id })}
                    >
                      <div className={'text-[13px] ' + (selected ? 'font-semibold text-ink-12' : 'font-medium text-ink-11')}>
                        {i === 0 && (
                          <span aria-label="latest" className="mr-1 text-ink-9">●</span>
                        )}
                        {v.editor}
                      </div>
                      <div
                        className="mt-0.5 text-[10.5px] text-ink-7 tabular-nums"
                        style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
                      >
                        {fmtTime(v.edited_at)} <span className="text-ink-3">·</span> {fmtSize(v.size_bytes)}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="overflow-auto">
              {bodyOf === null && (
                <p className="text-[13px] text-ink-7">loading…</p>
              )}
              {bodyOf !== null && (
                <>
                  {currentBody !== null && bodyOf.body === currentBody && (
                    <p className="m-0 mb-3 text-[11.5px] text-ink-7">
                      この版は現在の本文と一致します。
                    </p>
                  )}
                  <article className="article">
                    <div className="markdown-body">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeSanitize]}
                      >
                        {bodyOf.body}
                      </ReactMarkdown>
                    </div>
                  </article>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
