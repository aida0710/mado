import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'

// Storage タブの入口。デフォルト接続 → created_at 最古 → 0 件なら空状態、へ振り分ける。
// 接続の切り替えは画面右上の CONN スイッチャーが担うため、選択画面はもう無い。
function pickConnection(list: Connection[]): Connection | null {
  if (list.length === 0) return null
  return (
    list.find(c => c.isDefault)
    ?? [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
  )
}

export default function StorageLanding() {
  const [empty, setEmpty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listConnections()
      .then(list => {
        const target = pickConnection(list)
        if (target) navigate(`/storage/${encodeURIComponent(target.id)}/`, { replace: true })
        else setEmpty(true)
      })
      .catch(e => setError((e as Error).message))
  }, [navigate])

  if (error) return <p className="error">{error}</p>
  if (!empty) return <p className="text-[13px] text-ink-7">読み込み中…</p>
  return (
    <div className="empty-state">
      <h2>接続がまだありません</h2>
      <p>
        ここに表示する S3 互換ストレージはまだ登録されていません。<br />
        設定ページから一つ追加してみましょう。
      </p>
      <Link className="empty-state__cta" to="/settings">接続を追加</Link>
    </div>
  )
}
