import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'
import { useCodeLanguage } from '../lib/useCodeLanguage'
import { useSniffedText } from '../lib/useSniffedText'
import { CodeFormatSelect, CodeView } from './CodeView'
import { UnsupportedPreview } from './UnsupportedPreview'

export function PreviewText({ connectionId, bucket, k }: { connectionId: string; bucket: string; k: string }) {
  const sniffed = useSniffedText(api.textPreviewUrl(connectionId, bucket, k))

  if (sniffed.status === 'error') return <p className="notice error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="muted">読み込み中…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />
  return <TextBody name={k} text={sniffed.text} />
}

/** 読み込んだテキスト。形式を推測して色を付け、帯の選択欄で形式を選び直せる。 */
function TextBody({ name, text }: { name: string; text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const code = useCodeLanguage(name, text)

  const handleCopy = async () => {
    setCopied(await copyToClipboard(text))
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="preview-stack">
      <div className="preview-toolbar">
        <CodeFormatSelect code={code} />
        <div className="preview-actions">
          <CopyContentButton copied={copied} onCopy={handleCopy} />
        </div>
      </div>
      <CodeView text={text} language={code.language} className="preview-code" />
    </div>
  )
}

/**
 * 本文を丸ごとコピーするボタン。押した後 1.5 秒だけ結果 (コピーしました / コピー失敗) を出す。
 * copied は null = まだ押していない、true / false = 直前のコピーの成否。
 */
export function CopyContentButton({ copied, onCopy }: { copied: boolean | null; onCopy: () => void }) {
  return (
    <button
      type="button"
      className="button small"
      onClick={onCopy}
      title="内容をコピー"
      aria-label="内容をコピー"
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied == null ? '内容をコピー' : copied ? 'コピーしました' : 'コピー失敗'}
    </button>
  )
}
