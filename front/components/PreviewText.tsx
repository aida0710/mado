import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'

export function PreviewText({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  const [text, setText] = useState<string>('loading…')
  useEffect(() => {
    let cancelled = false
    fetch(api.textPreviewUrl(connId, bucket, k))
      .then(r => r.ok ? r.text() : Promise.reject(new Error(r.statusText)))
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setText(`error: ${e.message}`) })
    return () => { cancelled = true }
  }, [connId, bucket, k])
  return (
    <pre className="m-0 max-h-[70vh] overflow-auto whitespace-pre rounded-2 border border-ink-2 bg-ink-0 p-2 text-xs leading-snug">
      {text}
    </pre>
  )
}
