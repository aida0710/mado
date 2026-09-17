import type { ReactNode } from 'react'
import { useEscapeToClose } from '../lib/useEscapeToClose'

interface Props {
  /** 見出し要素の id。dialog の aria-labelledby に使う。 */
  titleId: string
  onClose: () => void
  /** Markdown を表示するモーダルは light に固定する (markdown-body の配色がテーマに追従しないため)。 */
  colorMode?: 'light'
  children: ReactNode
}

/** 全画面の backdrop + dialog の骨組み。Escape と backdrop クリックで閉じる。
 *  見出しや本文は呼び出し側が描く。 */
export function ModalShell({ titleId, onClose, colorMode, children }: Props) {
  useEscapeToClose(onClose)
  return (
    <div className="modal-backdrop modal-backdrop--entry" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        onClick={onClose}
        aria-label="モーダルを閉じる"
        tabIndex={-1}
      />
      <div
        className="modal modal--entry"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-color-mode={colorMode}
      >
        {children}
      </div>
    </div>
  )
}
