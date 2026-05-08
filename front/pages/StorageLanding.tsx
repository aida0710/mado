import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'

export default function StorageLanding() {
  const [connections, setConnections] = useState<Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listConnections()
      .then(list => {
        setConnections(list)
        if (list.length === 1) navigate(`/storage/${encodeURIComponent(list[0].id)}/`, { replace: true })
      })
      .catch(e => setError((e as Error).message))
  }, [navigate])

  if (error) return <p className="error">{error}</p>
  if (!connections) {
    return <p className="text-[13px] text-ink-7">読み込み中…</p>
  }
  if (connections.length === 0) {
    return (
      <div className="empty-state">
        <h2>接続がまだありません</h2>
        <p>
          ここに表示する S3 互換ストレージはまだ登録されていません。<br />
          設定ページから一つ追加してみましょう。
        </p>
        <Link className="empty-state__cta" to="/connections">接続を追加</Link>
      </div>
    )
  }
  return (
    <div>
      <header className="page-head">
        <h2>接続を選択</h2>
        <Link className="ghost" to="/connections">接続を管理</Link>
        <p className="page-head__sub">開きたいバケット群を持つ S3 互換ストレージを選んでください</p>
      </header>

      {/* Editorial row list — table of contents 風。
          名前 (Public Sans 600) を左、 endpoint/region/key を右 mono。
          card border は使わず、行の hairline divider のみで構造化する。 */}
      <ul
        className="m-0 list-none p-0"
        style={{ borderTop: '1px solid var(--rule)' }}
      >
        {connections.map(c => (
          <li
            key={c.id}
            className="group transition-colors hover:bg-ink-0"
            style={{ borderBottom: '1px solid var(--rule)' }}
          >
            <Link
              to={`/storage/${encodeURIComponent(c.id)}/`}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-4 text-inherit no-underline"
            >
              <strong className="text-[15px] font-semibold tracking-[0.005em] text-ink-12">
                {c.name}
              </strong>
              <span
                className="font-mono text-[12px] text-ink-7 transition-colors group-hover:text-ink-9"
                style={{ letterSpacing: '0.01em' }}
              >
                {c.endpoint} <span className="text-ink-3">·</span>{' '}
                {c.region} <span className="text-ink-3">·</span>{' '}
                {c.accessKeyIdMasked}
                <span
                  className="ml-3 text-ink-5 transition-transform duration-[200ms] group-hover:translate-x-0.5 group-hover:text-ink-12 inline-block"
                  aria-hidden
                >→</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
