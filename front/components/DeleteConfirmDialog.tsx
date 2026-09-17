import { useState, type ReactNode } from 'react'

interface Props {
  titleId: string
  /** 見出し上の小さなラベル ("Settings · 削除" など)。どこの操作かを示す。 */
  kicker: string
  title: string
  /** 何を削除するかの説明。名前を強調したいときは呼び出し側で JSX にする。 */
  children: ReactNode
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/** 「〜を削除します。よろしいですか?」の確認ダイアログ。
 *  削除中はボタンを止め、失敗したら理由をダイアログ内に出して閉じない。 */
export function DeleteConfirmDialog({ titleId, kicker, title, children, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <p className="kicker">{kicker}</p>
        <h3 id={titleId}>{title}</h3>
        <p className="text-[14px] leading-relaxed text-ink-9">{children}</p>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>キャンセル</button>
          <button
            onClick={submit}
            disabled={busy}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--paper)' }}
          >
            {busy ? '削除中…' : '削除'}
          </button>
        </div>
      </div>
    </div>
  )
}
