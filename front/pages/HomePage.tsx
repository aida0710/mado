import { useCallback, useEffect, useMemo, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { Note } from '../lib/api/types'
import { MarkdownEditor } from '../components/MarkdownEditor'

type NoteData = z.infer<typeof Note>

function formatByline(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ja-JP', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function HomePage() {
  const [data, setData] = useState<NoteData | null>(null)
  const [editing, setEditing] = useState(false)

  const refresh = useCallback(() => {
    api.note('home').then(setData).catch(() => setData({ exists: false }))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const byline = useMemo(() => {
    if (!data?.exists) return null
    const parts: string[] = []
    if (data.last_editor) parts.push(data.last_editor)
    if (data.last_edited_at) parts.push(formatByline(data.last_edited_at))
    return parts.length ? parts.join(' · ') : null
  }, [data])

  if (!data) return null

  const isPresent = data.exists && data.body.trim().length > 0

  return (
    <>
      <div data-color-mode="light">
        <header className="page-head">
          <h2>Team notes</h2>
          <button className="ghost" onClick={() => setEditing(true)}>
            {data.exists ? '✎ edit' : '✎ create'}
          </button>
        </header>

        {isPresent ? (
          <article>
            <MDEditor.Markdown source={data.body} />
          </article>
        ) : (
          <div className="empty-state">
            <p className="text-ink-7">まだホームノートがありません。</p>
            <button className="empty-state__cta" onClick={() => setEditing(true)}>
              最初のノートを書く
            </button>
          </div>
        )}

        {byline && (
          <footer
            className={
              "mt-8 text-center text-xs text-ink-7 " +
              "before:mx-3 before:inline-block before:h-px before:w-6 before:bg-ink-3 before:align-middle " +
              "after:mx-3 after:inline-block after:h-px after:w-6 after:bg-ink-3 after:align-middle"
            }
          >
            <span>{byline}</span>
          </footer>
        )}
      </div>

      {editing && (
        <MarkdownEditor
          title="Edit Home"
          initialBody={data.exists ? data.body : ''}
          initialEditor={data.exists ? (data.last_editor ?? '') : ''}
          onSave={(body, editor) =>
            api.putNote('home', body, editor).then(() => undefined)
          }
          onSaved={() => { setEditing(false); refresh() }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}
