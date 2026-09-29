import type { ReactNode } from 'react'

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
    <div role="alert" className="py-2">
      <p className="error">{subject}を読み込めませんでした{reason && `（${reason}）`}</p>
      {children && <p className="mb-3 text-[13px] text-ink-7">{children}</p>}
      <button type="button" className="ghost" onClick={onRetry}>再試行</button>
    </div>
  )
}
