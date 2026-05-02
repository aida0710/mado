import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { useConnection } from '../lib/connectionContext'
import { encSegment } from '../lib/route'

const itemClass =
  'block w-full px-3 py-2 text-left bg-transparent border-0 text-ink-11 ' +
  'cursor-pointer transition-colors no-underline hover:bg-ink-1'
const itemMutedClass = 'text-ink-7 cursor-default hover:bg-transparent'

export function ConnectionSwitcher() {
  const current = useConnection()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Connection[] | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  // 初回オープン時にリストを遅延フェッチする。
  useEffect(() => {
    if (open && list === null) {
      api.listConnections()
        .then(setList)
        .catch(() => setList([]))
    }
  }, [open, list])

  // 外部クリック / Escape でドロップダウンを閉じる。
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const others = (list ?? []).filter(c => c.id !== current.id)

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        className="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        接続: {current.name} ▾
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 min-w-[220px] rounded-3 border border-ink-3 bg-paper py-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
          style={{ top: 'calc(100% + 4px)' }}
          role="menu"
        >
          {list === null && (
            <div className={`${itemClass} ${itemMutedClass}`}>読み込み中…</div>
          )}
          {list !== null && others.length === 0 && (
            <div className={`${itemClass} ${itemMutedClass}`}>
              他の接続はありません
            </div>
          )}
          {others.map(c => (
            <button
              key={c.id}
              role="menuitem"
              className={itemClass}
              onClick={() => { setOpen(false); navigate(`/storage/${encSegment(c.id)}/`) }}
            >
              {c.name}
            </button>
          ))}
          <div className="my-1 h-px bg-ink-2" />
          <Link
            role="menuitem"
            className={itemClass}
            to="/connections"
            onClick={() => setOpen(false)}
          >
            ⚙ 接続を管理…
          </Link>
        </div>
      )}
    </div>
  )
}
