import { DeleteConfirmDialog } from './DeleteConfirmDialog'

interface Props {
  name: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function ConnectionDeleteConfirm({ name, onConfirm, onCancel }: Props) {
  return (
    <DeleteConfirmDialog
      titleId="connection-delete-title"
      kicker="Settings · 削除"
      title="接続を削除"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      接続&nbsp;
      <span className="font-semibold text-ink-12" style={{ fontFamily: 'var(--font-mono)' }}>
        {name}
      </span>
      &nbsp;を削除します。よろしいですか?
    </DeleteConfirmDialog>
  )
}
