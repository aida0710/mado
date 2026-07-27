import { useId, useRef, useState } from 'react'
import { readJsonFile, summaryText, type ImportSummary } from '../lib/jsonFile'

interface Props {
  /** 対象名 (例: 接続 / タグ / 家系図)。隠し input の aria-label に使う。
   *  1 画面に複数置くとボタン名だけでは区別がつかないため。 */
  what: string
  /** エクスポート押下時。ファイルの組み立てと保存は呼び出し側。 */
  onExport: () => void
  /** インポート。読み込んだ JSON を受け取り、件数のまとめを返す。 */
  onImport: (data: unknown) => Promise<ImportSummary>
  /** 完了後に一覧を取り直す。 */
  onDone?: () => void
  exportLabel?: string
  importLabel?: string
}

// タグ / 家系図で共通のインポート・エクスポート導線。
// <input type="file"> は見た目を揃えにくいので隠し、ボタンから click() で開く。
export function ImportExportButtons({
  what, onExport, onImport, onDone, exportLabel = 'エクスポート', importLabel = 'インポート',
}: Props) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const data = await readJsonFile(file)
      const summary = await onImport(data)
      setMessage(summaryText(summary))
      // 失敗が出たときだけ理由を見せる (全部は出さない — 件数で足りる)。
      if (summary.failed.length > 0) setError(summary.failed.slice(0, 3).join(' / '))
      onDone?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      // 同じファイルを選び直せるように値を空にする。
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="ghost" onClick={onExport} disabled={busy}>
        {exportLabel}
      </button>
      <button
        type="button"
        className="ghost"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy ? '取り込み中…' : importLabel}
      </button>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label={`${what}をインポート`}
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
        }}
      />
      {message && <span className="text-[12px] text-ink-7">{message}</span>}
      {error && <span className="text-[12px]" style={{ color: 'var(--danger)' }} role="alert">{error}</span>}
    </span>
  )
}
