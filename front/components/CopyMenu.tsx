import { useEffect, useRef, useState } from 'react'

interface Props {
  // 表示する候補。label と取得関数のペア。
  items: Array<{ label: string; value: string }>
  // ボタン上に表示するラベル (default: "コピー")
  trigger?: string
}

// クリックでドロップダウンを開き、項目を選ぶと clipboard にコピーする小さい
// メニュー。クリック外 / Escape で閉じる。Tailwind utility だけで作る。
export function CopyMenu({ items, trigger = 'コピー' }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
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

  const onPick = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch (err) {
      console.error('clipboard write failed', err)
    }
    setOpen(false)
  }

  return (
    <div ref={root} className="relative inline-flex" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="ghost text-xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {copied ? `${copied} ✓` : `${trigger} ▾`}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 min-w-[200px] rounded-3 border border-ink-3 bg-paper py-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
          style={{ top: 'calc(100% + 4px)' }}
        >
          {items.map(it => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              className="block w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-ink-11 transition-colors hover:bg-ink-1"
              onClick={() => onPick(it.label, it.value)}
              title={it.value}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
