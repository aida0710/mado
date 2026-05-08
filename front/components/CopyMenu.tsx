import { memo, useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '../lib/clipboard'

export type MenuItem =
  | { kind: 'copy'; label: string; value: string }
  | { kind: 'download'; label: string; href: string; filename: string }

interface Props {
  items: MenuItem[]
  // 初期表示のトリガー (default: "⋯")
  trigger?: string
  ariaLabel?: string
}

// ファイル行のアクションメニュー。クリックで開き、項目を選んで実行。
// クリック外 / Escape で閉じる。
//
// memo でラップ: StorageBrowser の各行は items を useMemo で安定化して
// 渡すので、親の再レンダ時 (loading フラグ更新等) に各 CopyMenu を
// 再描画しなくて済む。
export const CopyMenu = memo(function CopyMenu({ items, trigger = '⋯', ariaLabel = 'アクション' }: Props) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
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
    <div ref={root} className="relative inline-flex" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="ghost text-base leading-none"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(o => !o)}
        title={ariaLabel}
      >
        {feedback ?? trigger}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 min-w-[280px] max-w-[480px] bg-paper py-1"
          style={{
            top: 'calc(100% + 6px)',
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
                    'block w-full cursor-pointer border-0 bg-transparent px-3 py-2 ' +
                    'text-[13px] text-ink-11 no-underline transition-colors hover:bg-ink-1'
                  }
                  onClick={() => setOpen(false)}
                >
                  {it.label}
                </a>
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
                onClick={() => onCopy(it.label, it.value)}
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
        </div>
      )}
    </div>
  )
})
