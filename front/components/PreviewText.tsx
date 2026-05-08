import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'

export function PreviewText({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  const [text, setText] = useState<string>('loading…')
  useEffect(() => {
    let cancelled = false
    api.textPreview(connId, bucket, k)
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setText(`error: ${e.message}`) })
    return () => { cancelled = true }
  }, [connId, bucket, k])
  return (
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
      {text}
    </pre>
  )
}
