import type { ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

interface Props {
  /** 読み込めなかったもの（例: 'README'）。 */
  subject: string
  /** 失敗の理由（サーバーのエラー文言など）。空なら出さない。 */
  reason: string
  onRetry: () => void
  /** 補足（例: 編集できない理由）。 */
  children?: ReactNode
}

// 取得の失敗を「まだ無い」と区別して知らせ、取り直せるようにする。
export function LoadFailedNotice({ subject, reason, onRetry, children }: Props) {
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <span>
        {subject}を読み込めませんでした{reason && `（${reason}）`}
        {children && <span className="load-failed__note">{children}</span>}
      </span>
      <button type="button" className="button small" onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" />
        再試行
      </button>
    </div>
  )
}
