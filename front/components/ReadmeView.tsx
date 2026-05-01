import { useCallback, useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { api } from '../lib/api/client'
import type { z } from 'zod'
import { Readme } from '../lib/api/types'
import { MarkdownEditor } from './MarkdownEditor'

type ReadmeData = z.infer<typeof Readme>

interface Props {
  connId: string
  bucket: string
  prefix: string
}

export function ReadmeView({ connId, bucket, prefix }: Props) {
  const [data, setData] = useState<ReadmeData | null>(null)
  const [editing, setEditing] = useState(false)

  const refresh = useCallback(() => {
    api.readme(connId, bucket, prefix).then(setData).catch(() => setData({ exists: false }))
  }, [connId, bucket, prefix])

  useEffect(() => { refresh() }, [refresh])

  if (!data) return null
  return (
    <section
      className="mb-6 border-b border-ink-2 pb-4"
      data-color-mode="light"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="m-0 text-sm font-semibold">README</h3>
        <button className="ghost" onClick={() => setEditing(true)}>
          {data.exists ? '✎ edit' : '✎ create'}
        </button>
        {data.exists && data.last_editor && (
          <span className="text-ink-7">last by {data.last_editor}</span>
        )}
      </header>
      {data.exists
        ? <div className="mt-2"><MDEditor.Markdown source={data.body} /></div>
        : <p className="text-ink-7">README なし</p>}
      {editing && (
        <MarkdownEditor
          title={`Edit README — ${prefix || '(root)'}`}
          initialBody={data.exists ? data.body : ''}
          initialEditor={data.exists ? (data.last_editor ?? '') : ''}
          onSave={(body, editor) =>
            api.putReadme(connId, bucket, prefix, body, editor).then(() => undefined)
          }
          onSaved={() => { setEditing(false); refresh() }}
          onClose={() => setEditing(false)}
        />
      )}
    </section>
  )
}
