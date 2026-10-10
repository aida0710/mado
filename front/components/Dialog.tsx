import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useEscapeToClose } from '../lib/useEscapeToClose'

const ignoreEscape = () => {}

interface Props {
  /** 見出し (h2) の id。dialog の aria-labelledby に使う。 */
  titleId: string
  title: ReactNode
  /** 見出しの下に小さく出す、対象のパスなどの補足。 */
  subtitle?: ReactNode
  /** 閉じるボタン・Escape・背景のクリックで呼ぶ。渡さなければ閉じる手段を出さない。 */
  onClose?: () => void
  closeLabel?: string
  /** 処理中などで閉じさせたくない間は false。閉じるボタンも止める。 */
  dismissible?: boolean
  /** 幅。既定 560px、wide 740px、extra-wide 1040px。 */
  size?: 'default' | 'wide' | 'extra-wide'
  /** 640px 未満での形。既定は全画面、sheet は下から出る (短い確認向け)。 */
  narrowLayout?: 'fullscreen' | 'sheet'
  /** プレビューの上に重ねるときは true (背景を一段上に出す)。 */
  nested?: boolean
  /** 下に並べるボタン。<footer> に入れる。 */
  footer?: ReactNode
  /** 本文。余白は呼び出し側が <div className="dialog-body"> か <form> で付ける。 */
  children: ReactNode
}

/**
 * ダイアログの骨組み。見た目は共通の部品の .dialog (見出しの帯、本文、下のボタン)。
 * 開いたときダイアログへフォーカスを移し、閉じたら元の場所へ戻す。
 */
export function Dialog({
  titleId,
  title,
  subtitle,
  onClose,
  closeLabel = '閉じる',
  dismissible = true,
  size = 'default',
  narrowLayout = 'fullscreen',
  nested = false,
  footer,
  children,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const close = onClose && dismissible ? onClose : undefined
  useEscapeToClose(close ?? ignoreEscape)

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus()
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  const classes = ['dialog']
  if (size !== 'default') classes.push(size)
  if (narrowLayout === 'sheet') classes.push('sheet-on-narrow')
  return (
    <div className={nested ? 'modal-backdrop nested' : 'modal-backdrop'} role="presentation">
      {close && (
        // 背景のクリックで閉じるためだけのボタン。キーボードと読み上げでは見出しの×と Escape を
        // 使うので、フォーカスの順番からも読み上げからも外す。
        <button
          type="button"
          className="modal-backdrop__close-overlay"
          onClick={close}
          aria-hidden="true"
          tabIndex={-1}
        />
      )}
      <div
        ref={dialogRef}
        className={classes.join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div className="dialog-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              className="icon-button"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={onClose}
              disabled={!dismissible}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}
