import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { Menu, X } from 'lucide-react'
import { NavigationLinkList } from './NavigationLinkList'
import { ProductName } from './ProductName'

/**
 * md (900px) 未満の画面の切り替え。上部バーのメニューボタンで左からドロワーを開く。
 * ドロワーはモーダルの <dialog> なので、Esc で閉じるとフォーカスはボタンへ戻る。
 * ドロワーの外側やリンクを押しても閉じる。
 */
export function NavigationDrawer() {
  const drawerId = useId()
  const drawerRef = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    const drawer = drawerRef.current
    if (!drawer) return
    if (isOpen && !drawer.open) drawer.showModal()
    if (!isOpen && drawer.open) drawer.close()
  }, [isOpen])
  const closeOnBackdropOrLink = (event: MouseEvent<HTMLDialogElement>) => {
    // 中のパネルが dialog の枠いっぱいに広がるので、dialog 自身に当たったクリックは外側の背景。
    const isBackdrop = event.target === event.currentTarget
    if (isBackdrop || (event.target as Element).closest('a')) setIsOpen(false)
  }
  return (
    <>
      <button
        type="button"
        className="icon-button navigation-toggle"
        aria-label={isOpen ? 'メニューを閉じる' : 'メニューを開く'}
        aria-expanded={isOpen}
        aria-controls={drawerId}
        onClick={() => setIsOpen(current => !current)}
      >
        <Menu size={20} />
      </button>
      <dialog
        ref={drawerRef}
        id={drawerId}
        className="navigation-drawer"
        aria-label="メインナビゲーション"
        onCancel={event => {
          event.preventDefault()
          setIsOpen(false)
        }}
        onClose={() => setIsOpen(false)}
        onClick={closeOnBackdropOrLink}
      >
        <div className="navigation-drawer-panel">
          <div className="navigation-drawer-header">
            <span><ProductName /></span>
            <button
              type="button"
              className="icon-button"
              aria-label="メニューを閉じる"
              onClick={() => setIsOpen(false)}
            >
              <X size={20} />
            </button>
          </div>
          <NavigationLinkList />
        </div>
      </dialog>
    </>
  )
}
