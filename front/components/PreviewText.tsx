import { useEffect, useState } from 'react'
import { api } from '../api/client'

export function PreviewText({ bucket, k }: { bucket: string; k: string }) {
  const [text, setText] = useState<string>('loading…')
  useEffect(() => {
    let cancelled = false
    fetch(api.textPreviewUrl(bucket, k))
      .then(r => r.ok ? r.text() : Promise.reject(new Error(r.statusText)))
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setText(`error: ${e.message}`) })
    return () => { cancelled = true }
  }, [bucket, k])
  return <pre className="prev-text">{text}</pre>
}
