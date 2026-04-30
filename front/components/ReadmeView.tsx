import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { z } from 'zod'
import { Readme } from '../api/types'
import { ReadmeEditor } from './ReadmeEditor'

type ReadmeData = z.infer<typeof Readme>

interface Props {
  bucket: string
  prefix: string
}

export function ReadmeView({ bucket, prefix }: Props) {
  const [data, setData] = useState<ReadmeData | null>(null)
  const [editing, setEditing] = useState(false)

  const refresh = useCallback(() => {
    api.readme(bucket, prefix).then(setData).catch(() => setData({ exists: false }))
  }, [bucket, prefix])

  useEffect(() => { refresh() }, [refresh])

  if (!data) return null
  return (
    <section className="readme">
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
        ? <pre className="readme__body">{data.body}</pre>
        : <p className="muted">README なし</p>}
      {editing && (
        <ReadmeEditor
          bucket={bucket}
          prefix={prefix}
          initialBody={data.exists ? data.body : ''}
          initialEditor={data.exists ? (data.last_editor ?? '') : ''}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh() }}
        />
      )}
    </section>
  )
}
