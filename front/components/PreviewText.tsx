import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'

export function PreviewText({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.textPreview(connId, bucket, k)
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [connId, bucket, k])

  if (error) return <p className="error">{error}</p>
  if (text === null) return <p className="text-[13px] text-ink-7">loading…</p>

  const handleCopy = async () => {
    const ok = await copyToClipboard(text)
    setCopyMsg(ok ? 'コピーしました ✓' : 'コピー失敗')
    setTimeout(() => setCopyMsg(null), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
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
        {text}
      </pre>
    </div>
  )
}
