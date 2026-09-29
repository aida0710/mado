import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

interface Props {
  /** 見出し要素の id。dialog の aria-labelledby に使う。 */
  titleId: string
  children: ReactNode
}

// 背後の画面が window や document で受けているキー操作（Escape でモーダルを閉じるなど）へ
// 届かせない。React は root で受けてから stopPropagation を元のイベントにも伝えるので、
// window と document の listener には届かない。
const keepKeyInOverlay = (event: KeyboardEvent) => event.stopPropagation()

/**
 * session が切れたとき、開いていた画面の上にログイン画面（または初回のパスワード変更画面）を
 * 重ねる。背後の画面は AuthGate が inert にして残す。入り直すまで閉じられないので、ModalShell と
 * 違って Escape や背景のクリックでは閉じない。
 */
export function AuthOverlay({ titleId, children }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // 背後の画面は inert で focus を受け取れないので、focus をこちらへ移す。
  useEffect(() => { dialogRef.current?.focus() }, [])

  return (
    <div
      ref={dialogRef}
      className="auth-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={keepKeyInOverlay}
    >
      {children}
    </div>
  )
}
