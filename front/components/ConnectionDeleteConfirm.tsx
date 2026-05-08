import { useState } from 'react'

interface Props {
  name: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function ConnectionDeleteConfirm({ name, onConfirm, onCancel }: Props) {
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
      <div
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conn-delete-title"
      >
        <p className="kicker">Settings · 削除</p>
        <h3 id="conn-delete-title">接続を削除</h3>
        <p className="text-[14px] leading-relaxed text-ink-9">
          接続&nbsp;
          <span
            className="font-semibold text-ink-12"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {name}
          </span>
          &nbsp;を削除します。よろしいですか?
        </p>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>キャンセル</button>
          <button
            className="conn-row__danger"
            onClick={submit}
            disabled={busy}
            style={{
              background: 'var(--danger)',
              borderColor: 'var(--danger)',
              color: 'var(--paper)',
            }}
          >
            {busy ? '削除中…' : '削除'}
          </button>
        </div>
      </div>
    </div>
  )
}
