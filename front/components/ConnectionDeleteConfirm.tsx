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
      title="接続を削除"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      接続 <strong className="mono">{name}</strong> を削除します。よろしいですか?
    </DeleteConfirmDialog>
  )
}
