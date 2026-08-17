import { useId, useRef, useState } from 'react'
import { readJsonFile, summaryText, type ImportMode, type ImportSummary } from '../lib/jsonFile'

interface Props {
  /** 対象名 (例: 接続 / タグ)。隠し input の aria-label に使う。
   *  1 画面に複数置くとボタン名だけでは区別がつかないため。 */
  what: string
  /** エクスポート押下時。ファイルの組み立てと保存は呼び出し側。 */
  onExport: () => void
  /** インポート。読み込んだ JSON と取り込み方法を受け取り、件数のまとめを返す。 */
  onImport: (data: unknown, mode: ImportMode) => Promise<ImportSummary>
  /** 置き換えを選んだときに追加で伝えたい影響 (連鎖削除など)。 */
  replaceWarning?: string
  /** 完了後に一覧を取り直す。 */
  onDone?: () => void
  exportLabel?: string
  importLabel?: string
}

// 接続 / タグで共通のインポート・エクスポート導線。
// <input type="file"> は見た目を揃えにくいので隠し、ボタンから click() で開く。
export function ImportExportButtons({
  what, onExport, onImport, onDone, replaceWarning,
  exportLabel = 'エクスポート', importLabel = 'インポート',
}: Props) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ファイルを読んだ時点では実行せず、取り込み方法を選んでもらう。
  // 置き換えは既存を消すので、黙って走らせない。
  const [picked, setPicked] = useState<unknown | null>(null)

  const handleFile = async (file: File) => {
    setMessage(null)
    setError(null)
    try {
      setPicked(await readJsonFile(file))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const run = async (mode: ImportMode) => {
    const data = picked
    setPicked(null)
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const summary = await onImport(data, mode)
      setMessage(summaryText(summary))
      // 失敗が出たときだけ理由を見せる (全部は出さない — 件数で足りる)。
      if (summary.failed.length > 0) setError(summary.failed.slice(0, 3).join(' / '))
      onDone?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
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

      {picked !== null && (
        <div className="modal-backdrop" role="presentation">
          <button
            type="button"
            className="modal-backdrop__close-overlay"
            onClick={() => setPicked(null)}
            aria-label="モーダルを閉じる"
            tabIndex={-1}
          />
          <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="import-mode-title">
            <h3 id="import-mode-title" className="modal-prompt__title">{what}の取り込み方法</h3>
            <p className="text-[12.5px] text-ink-11">
              <strong>追記</strong> — ファイルにあるものを足します。既存はそのまま残ります。
            </p>
            <p className="text-[12.5px] text-ink-11">
              <strong>置き換え</strong> — ファイルの内容に揃えます。
              <strong>ファイルに無い既存は削除されます。</strong>
              両方にあるものは作り直さずそのまま残ります。
            </p>
            {replaceWarning && (
              <p className="text-[12px]" style={{ color: 'var(--danger)' }}>{replaceWarning}</p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setPicked(null)}>キャンセル</button>
              <button type="button" onClick={() => void run('append')}>追記</button>
              <button type="button" onClick={() => void run('replace')}>置き換え</button>
            </div>
          </div>
        </div>
      )}
    </span>
  )
}
