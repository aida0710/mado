import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronDown, Settings } from 'lucide-react'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { useConnection } from '../lib/connectionContext'

/**
 * 見出しの右に置く接続先の切り替え。押すとほかの接続の一覧 (.popover) を開く。
 * 一覧は開いたときに初めて取得する。
 */
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
    <div className="connection-switcher" ref={ref}>
      <button
        type="button"
        className="button connection-switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="connection-switcher-label">Connection</span>
        <span className="connection-switcher-name">{current.name}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="popover connection-switcher-menu" role="menu">
          <div className="connection-switcher-heading">Connections</div>
          {list === null && <div className="connection-switcher-note">読み込み中…</div>}
          {list !== null && others.length === 0 && (
            <div className="connection-switcher-note">他の接続はありません</div>
          )}
          {others.map(c => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="connection-switcher-item"
              onClick={() => { setOpen(false); navigate(`/storage/${encodeURIComponent(c.id)}/`) }}
            >
              {/* 接続名とアドレスは行を分ける。1 行に並べると、狭い画面では
                  名前の途中で折り返って「どこまでが名前か」が読めなくなる。 */}
              <span className="connection-switcher-item-name">{c.name}</span>
              {/* endpoint は空白を含まない長い 1 トークン (R2 の
                  https://<32桁hash>.r2.cloudflarestorage.com 等) になりうるので
                  語中改行を許可する。 */}
              <span className="connection-switcher-endpoint">{c.endpoint}</span>
            </button>
          ))}
          <Link
            role="menuitem"
            className="connection-switcher-item connection-switcher-manage"
            to="/settings"
            onClick={() => setOpen(false)}
          >
            <Settings size={14} aria-hidden="true" />
            接続を管理…
          </Link>
        </div>
      )}
    </div>
  )
}
