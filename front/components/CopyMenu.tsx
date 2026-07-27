import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { copyToClipboard } from '../lib/clipboard'

export type MenuItem =
  | { kind: 'copy'; label: string; value: string }
  | { kind: 'download'; label: string; href: string; filename: string }
  | { kind: 'action'; label: string; onSelect: () => void }

// メニュー幅の下限 / 上限。className の min-w-[280px] / max-w-[480px] と対で、
// place() が viewport 幅に丸めるときの基準値にも使う。
const MENU_MIN_W = 280
const MENU_MAX_W = 480

interface Props {
  items: MenuItem[]
  // 初期表示のトリガー (default: "⋯")
  trigger?: string
  ariaLabel?: string
}

// ファイル行のアクションメニュー。クリックで開き、項目を選んで実行。
// クリック外 / Escape で閉じる。
//
// メニューは document.body へ portal し position:fixed で配置する。行を内包する
// overflow:auto なラッパー — テーブルの overflow-x-auto は CSS 仕様で overflow-y も
// auto に計算される / drawer の overflow:auto — にクリップされると、最下段や 1 件
// だけの行でメニューが枠外へ落ち、見るのに余計なスクロールを強いられるため。
//
// memo でラップ: StorageBrowser の各行は items を useMemo で安定化して
// 渡すので、親の再レンダ時 (loading フラグ更新等) に各 CopyMenu を
// 再描画しなくて済む。
export const CopyMenu = memo(function CopyMenu({ items, trigger = '⋯', ariaLabel = 'アクション' }: Props) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  // 確定した fixed 配置。未確定 (null) の間は不可視で描画してチラつきを防ぐ。
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // トリガの実座標から fixed 配置を計算する。横はトリガ右端に揃え、縦は下に
  // 収まらなければ上向きに開く。メニュー高さは実測 (offsetHeight) を優先し、
  // レイアウト未確定の環境では項目数からの概算でフォールバックする。
  const place = useCallback(() => {
    const btn = triggerRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const menuH = menuRef.current?.offsetHeight || items.length * 48 + 8
    const gap = 6
    const margin = 8
    const vw = window.innerWidth
    const spaceBelow = window.innerHeight - r.bottom
    const up = spaceBelow < menuH + gap && r.top > spaceBelow
    // 幅は className の min-w/max-w (280/480px) が基本だが、それを viewport 幅にも
    // 収める。スマホ幅では 280px の min-width が画面からはみ出す原因になるため、
    // min 側も同じ上限で丸める (inline style は class より優先されるので効く)。
    const maxW = Math.min(MENU_MAX_W, Math.max(0, vw - margin * 2))
    const minW = Math.min(MENU_MIN_W, maxW)
    const menuW = menuRef.current?.offsetWidth || minW
    // 横はトリガ右端に揃えるが、左端が画面外へ出ないよう right に上限をかける。
    // 揃えるだけだと、トリガが画面左寄りにある行 (パンくず等) を狭い画面で開いた
    // とき right が大きくなりすぎ、メニューが左へ突き抜けて見切れる。
    const right = Math.min(
      Math.max(margin, Math.round(vw - r.right)),
      Math.max(margin, vw - margin - menuW),
    )
    setMenuStyle({
      position: 'fixed',
      right,
      ...(up
        ? { bottom: Math.round(window.innerHeight - r.top + gap) }
        : { top: Math.round(r.bottom + gap) }),
      maxHeight: `calc(100vh - ${margin * 2}px)`,
      maxWidth: maxW,
      minWidth: minW,
    })
  }, [items.length])

  useLayoutEffect(() => {
    if (!open) { setMenuStyle(null); return }
    place()
    // 開いている間はスクロール (capture で入れ子のスクロール枠も拾う) と
    // リサイズで再配置し、トリガに貼り付いたままにする。
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      // トリガ側 (root) と portal 済みメニュー (menuRef) の内側なら閉じない。
      if (root.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onCopy = async (label: string, value: string) => {
    const ok = await copyToClipboard(value)
    setFeedback(ok ? `${label} ✓` : 'コピー失敗')
    setTimeout(() => setFeedback(null), 1500)
    setOpen(false)
  }

  return (
    <div ref={root} className="inline-flex">
      <button
        ref={triggerRef}
        type="button"
        className="ghost text-base leading-none"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        // 親行 (FileRow) の onClick=preview を抑止しつつメニューを開く。
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        // 行 (<tr>) の onKeyDown は Enter/Space で無条件に行アクション
        // (preview / モーダル) を発火するため、⋯ にフォーカスして Enter/Space を
        // 押すと伝播して誤発火する。その2キーだけ止める。native button の click は
        // ここで止めても発生するのでメニュー開閉は壊れない。Escape 等は止めない
        // ので、開いた直後に Escape で閉じる (document リスナ) が効いたまま。
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
        title={ariaLabel}
      >
        {feedback ?? trigger}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="z-50 min-w-[280px] max-w-[480px] overflow-y-auto bg-paper py-1"
          style={{
            ...menuStyle,
            // 配置確定前は不可視 (useLayoutEffect が paint 前に確定するのでチラつかない)。
            visibility: menuStyle ? 'visible' : 'hidden',
            border: '1px solid var(--color-rule-strong)',
            borderRadius: 'var(--radius-2)',
            boxShadow: '0 12px 28px -8px rgba(10, 9, 4, 0.20), 0 2px 6px rgba(10, 9, 4, 0.08)',
          }}
        >
          {items.map(it => {
            if (it.kind === 'download') {
              return (
                <a
                  key={it.label}
                  role="menuitem"
                  href={it.href}
                  download={it.filename}
                  className={
                    // text-left を明示: 親 td が text-right の文脈だと <a> は継承して
                    // 右寄せになってしまう (コピー項目の <button> と揃える)。
                    'block w-full cursor-pointer border-0 bg-transparent px-3 py-2 ' +
                    'text-left text-[13px] text-ink-11 no-underline transition-colors hover:bg-ink-1'
                  }
                  // 親行 (FileRow) の onClick=preview 抑止のため stopPropagation。
                  onClick={e => { e.stopPropagation(); setOpen(false) }}
                >
                  {it.label}
                </a>
              )
            }
            if (it.kind === 'action') {
              return (
                <button
                  key={it.label}
                  role="menuitem"
                  type="button"
                  className={
                    'block w-full cursor-pointer border-0 bg-transparent px-3 py-2 ' +
                    'text-left text-[13px] text-ink-11 transition-colors hover:bg-ink-1'
                  }
                  // 親行 (FileRow) の onClick=preview 抑止のため stopPropagation。
                  onClick={e => { e.stopPropagation(); it.onSelect(); setOpen(false) }}
                >
                  {it.label}
                </button>
              )
            }
            return (
              <button
                key={it.label}
                role="menuitem"
                type="button"
                className={
                  'block w-full cursor-pointer border-0 bg-transparent px-3 py-2 ' +
                  'text-left text-[13px] text-ink-11 transition-colors hover:bg-ink-1'
                }
                // 親行 (FileRow) の onClick=preview 抑止のため stopPropagation。
                onClick={e => { e.stopPropagation(); onCopy(it.label, it.value) }}
                title={it.value}
              >
                <div>{it.label}</div>
                <div
                  className="mt-0.5 truncate text-[11px] text-ink-7"
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                >
                  {it.value}
                </div>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
})
