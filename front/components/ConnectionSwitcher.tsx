import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Connection } from '../api/types'
import { useConnection } from '../lib/connectionContext'

export function ConnectionSwitcher() {
  const current = useConnection()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Connection[] | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  // Lazy fetch the list on first open.
  useEffect(() => {
    if (open && list === null) {
      api.listConnections()
        .then(setList)
        .catch(() => setList([]))
    }
  }, [open, list])

  // Close on outside click / Escape.
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
    <div className="conn-switcher" ref={ref}>
      <button
        className="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        接続: {current.name} ▾
      </button>
      {open && (
        <div className="conn-switcher__menu" role="menu">
          {list === null && <div className="conn-switcher__item muted">読み込み中…</div>}
          {list !== null && others.length === 0 && (
            <div className="conn-switcher__item muted">他の接続はありません</div>
          )}
          {others.map(c => (
            <button
              key={c.id}
              role="menuitem"
              className="conn-switcher__item"
              onClick={() => { setOpen(false); navigate(`/storage/${c.id}/`) }}
            >
              {c.name}
            </button>
          ))}
          <div className="conn-switcher__divider" />
          <Link
            role="menuitem"
            className="conn-switcher__item"
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
