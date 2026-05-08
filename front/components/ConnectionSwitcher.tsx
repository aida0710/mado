import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { useConnection } from '../lib/connectionContext'

const itemClass =
  'block w-full px-3 py-2 text-left bg-transparent border-0 text-ink-11 ' +
  'cursor-pointer transition-colors no-underline text-[13px] ' +
  'hover:bg-ink-1'
const itemMutedClass =
  'text-ink-7 cursor-default hover:bg-transparent'

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
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-ink-7">
          conn
        </span>
        <span className="text-ink-12">{current.name}</span>
        <span aria-hidden className="text-ink-7">▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 min-w-[240px] bg-paper py-1"
          style={{
            top: 'calc(100% + 6px)',
            border: '1px solid var(--color-rule-strong)',
            borderRadius: 'var(--radius-2)',
            boxShadow: '0 12px 28px -8px rgba(10, 9, 4, 0.20), 0 2px 6px rgba(10, 9, 4, 0.08)',
          }}
          role="menu"
        >
          <div
            className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-ink-7"
            style={{ borderBottom: '1px solid var(--rule)' }}
          >
            Connections
          </div>
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
              onClick={() => { setOpen(false); navigate(`/storage/${encodeURIComponent(c.id)}/`) }}
            >
              <span className="font-medium text-ink-12">{c.name}</span>
              <span
                className="ml-2 font-mono text-[11px] text-ink-7"
                style={{ letterSpacing: '0.01em' }}
              >
                {c.endpoint}
              </span>
            </button>
          ))}
          <div className="my-1 h-px" style={{ background: 'var(--rule)' }} />
          <Link
            role="menuitem"
            className={itemClass}
            to="/connections"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden className="mr-1">⚙</span>
            接続を管理…
          </Link>
        </div>
      )}
    </div>
  )
}
