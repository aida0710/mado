import { useCallback, useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { api } from '../api/client'
import type { z } from 'zod'
import { Readme } from '../api/types'
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
    <section className="readme" data-color-mode="light">
      <header className="readme__head">
        <h3>README</h3>
        <button className="ghost" onClick={() => setEditing(true)}>
          {data.exists ? '✎ edit' : '✎ create'}
        </button>
        {data.exists && data.last_editor && (
          <span className="muted">last by {data.last_editor}</span>
        )}
      </header>
      {data.exists
        ? <div className="readme__body"><MDEditor.Markdown source={data.body} /></div>
        : <p className="muted">README なし</p>}
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
