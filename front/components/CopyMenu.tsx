import {
  memo, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, Ellipsis, X } from 'lucide-react'
import { copyToClipboard } from '../lib/clipboard'

export type MenuItem =
  | { kind: 'copy'; label: string; value: string }
  | { kind: 'download'; label: string; href: string; filename: string }
  | { kind: 'action'; label: string; onSelect: () => void }

// メニュー幅の下限 / 上限。storage.css の .copy-menu-list の min-width / max-width と対で、
// place() が viewport 幅に丸めるときの基準値にも使う。
const MENU_MIN_W = 280
const MENU_MAX_W = 480
// コピーした結果を見せておく時間。
const FEEDBACK_MS = 1500
// メニューと結果の吹き出しをトリガーから離す距離と、画面の端に残す余白。
const GAP = 6
const MARGIN = 8

interface Props {
  items: MenuItem[]
  /** トリガーの中身。既定は ⋯ のアイコン。 */
  trigger?: ReactNode
  ariaLabel?: string
}

interface Feedback {
  text: string
  ok: boolean
  style: CSSProperties
}

// 親の行 (<tr role="button">) の Enter / Space は行の操作 (プレビュー) を起こすので、
// メニューの中で押したキーは行へ伝えない。Escape は止めない (document で閉じる)。
const stopRowKeys = (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
}

// 行や見出しの操作メニュー。アイコンのボタン (.icon-button) で開き、項目を選んで実行する。
// クリック外 / Escape で閉じる。コピーの結果はトリガーの上に小さな吹き出しで出す。
//
// メニューと吹き出しは document.body へ portal し position:fixed で配置する。行を内包する
// overflow:auto なラッパー — 表の .table-scroll (overflow-x:auto は CSS 仕様で overflow-y も
// auto になる) / ドロワーの本文 — にクリップされると、最下段や 1 件だけの行でメニューが
// 枠外へ落ち、見るのに余計なスクロールを強いられるため。
//
// memo でラップ: 一覧の各行は items を useMemo で安定化して渡すので、親の再レンダ時
// (loading フラグ更新等) に各 CopyMenu を再描画しなくて済む。
export const CopyMenu = memo(function CopyMenu({ items, trigger, ariaLabel = 'アクション' }: Props) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  // 確定した fixed 配置。未確定 (null) の間は不可視で描画してチラつきを防ぐ。
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const feedbackTimer = useRef<number | null>(null)

  // トリガの実座標から fixed 配置を計算する。横はトリガ右端に揃え、縦は下に
  // 収まらなければ上向きに開く。メニュー高さは実測 (offsetHeight) を優先し、
  // レイアウト未確定の環境では項目数からの概算でフォールバックする。
  const place = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const r = trigger.getBoundingClientRect()
    const menuH = menuRef.current?.offsetHeight || items.length * 48 + 8
    const vw = window.innerWidth
    const spaceBelow = window.innerHeight - r.bottom
    const up = spaceBelow < menuH + GAP && r.top > spaceBelow
    // 幅は CSS の min-width/max-width (280/480px) が基本だが、それを viewport 幅にも
    // 収める。スマホ幅では 280px の min-width が画面からはみ出す原因になるため、
    // min 側も同じ上限で丸める (inline style は class より優先されるので効く)。
    const maxW = Math.min(MENU_MAX_W, Math.max(0, vw - MARGIN * 2))
    const minW = Math.min(MENU_MIN_W, maxW)
    const menuW = menuRef.current?.offsetWidth || minW
    // 横はトリガ右端に揃えるが、左端が画面外へ出ないよう right に上限をかける。
    // 揃えるだけだと、トリガが画面左寄りにある行を狭い画面で開いたとき right が
    // 大きくなりすぎ、メニューが左へ突き抜けて見切れる。
    const right = Math.min(
      Math.max(MARGIN, Math.round(vw - r.right)),
      Math.max(MARGIN, vw - MARGIN - menuW),
    )
    setMenuStyle({
      position: 'fixed',
      right,
      ...(up
        ? { bottom: Math.round(window.innerHeight - r.top + GAP) }
        : { top: Math.round(r.bottom + GAP) }),
      maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
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
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => () => {
    if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current)
  }, [])

  // 吹き出しはトリガーの上 (上に余地が無ければ下) に、右端を揃えて出す。
  const showFeedback = (text: string, ok: boolean) => {
    const r = triggerRef.current?.getBoundingClientRect()
    const style: CSSProperties = r
      ? {
          position: 'fixed',
          right: Math.max(MARGIN, Math.round(window.innerWidth - r.right)),
          ...(r.top > 48
            ? { bottom: Math.round(window.innerHeight - r.top + GAP) }
            : { top: Math.round(r.bottom + GAP) }),
        }
      : { position: 'fixed', right: MARGIN, bottom: MARGIN }
    setFeedback({ text, ok, style })
    if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), FEEDBACK_MS)
  }

  const onCopy = async (label: string, value: string) => {
    setOpen(false)
    const ok = await copyToClipboard(value)
    showFeedback(ok ? label : 'コピー失敗', ok)
  }

  let triggerContent = trigger ?? <Ellipsis size={16} aria-hidden="true" />
  if (feedback) {
    triggerContent = feedback.ok
      ? <Check size={16} aria-hidden="true" />
      : <X size={16} aria-hidden="true" />
  }

  return (
    <div ref={root} className="copy-menu">
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        // 親行 (FileRow) の onClick=preview を抑止しつつメニューを開く。
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        // 行 (<tr>) の onKeyDown は Enter/Space で行アクション (preview / モーダル) を
        // 発火するため、ここで押した 2 キーは伝播させない。native button の click は
        // ここで止めても発生するのでメニュー開閉は壊れない。Escape 等は止めない
        // ので、開いた直後に Escape で閉じる (document リスナ) が効いたまま。
        onKeyDown={stopRowKeys}
        title={ariaLabel}
      >
        {triggerContent}
      </button>
      {feedback && createPortal(
        <span
          role="status"
          className={feedback.ok ? 'copy-menu-feedback' : 'copy-menu-feedback is-error'}
          style={feedback.style}
        >
          {feedback.ok && <Check size={13} aria-hidden="true" />}
          {feedback.text}
        </span>,
        document.body,
      )}
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="copy-menu-list"
          onKeyDown={stopRowKeys}
          style={{
            ...menuStyle,
            // 配置確定前は不可視 (useLayoutEffect が paint 前に確定するのでチラつかない)。
            visibility: menuStyle ? 'visible' : 'hidden',
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
                  className="copy-menu-item"
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
                  className="copy-menu-item"
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
                className="copy-menu-item"
                // 親行 (FileRow) の onClick=preview 抑止のため stopPropagation。
                onClick={e => { e.stopPropagation(); void onCopy(it.label, it.value) }}
                title={it.value}
              >
                {it.label}
                <span className="copy-menu-value">{it.value}</span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
})
