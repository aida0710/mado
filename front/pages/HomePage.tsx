import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { Note } from '../lib/api/types'

// 履歴モーダルはボタンを押した後にだけ描画する。React.lazy() で別チャンクへ。
const NoteHistoryModal = lazy(() =>
  import('../components/NoteHistoryModal').then(m => ({ default: m.NoteHistoryModal })),
)

type NoteData = z.infer<typeof Note>

function formatByline(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ja-JP', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function HomePage() {
  const [data, setData] = useState<NoteData | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const refresh = useCallback(() => {
    api.note('home').then(setData).catch(() => setData({ exists: false }))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 軽量な派生値 — useMemo の deps 比較コストの方が高くつくので
  // 素直にレンダ中に派生させる。byline は editor / when の 2 つの片を
  // .byline クラスの構造 (各 <span> に飾り罫 + 中点) に渡したいので
  // 単一文字列ではなくフィールドのまま保持する。
  const bylineEditor = data?.exists ? (data.last_editor || null) : null
  const bylineWhen   = data?.exists && data.last_edited_at ? formatByline(data.last_edited_at) : null
  const hasByline    = bylineEditor || bylineWhen

  if (!data) return null

  const isPresent = data.exists && data.body.trim().length > 0

  return (
    <>
      <div data-color-mode="light">
        <header className="page-head">
          <h2>Team note</h2>
          <Link className="ghost" to="/edit-note">
            <span aria-hidden>✎</span>
            {data.exists ? '編集' : '作成'}
          </Link>
          <button
            className="ghost"
            onClick={() => setHistoryOpen(true)}
            title="編集履歴を表示"
          >
            <span aria-hidden>⏱</span>
            履歴
          </button>
          <p className="page-head__sub">Mado 全体で1つの共有メモ</p>
        </header>

        {isPresent ? (
          <article className="article mt-2">
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
              >
                {data.body}
              </ReactMarkdown>
            </div>
          </article>
        ) : (
          <div className="empty-state">
            <h3>まだ何も書かれていません</h3>
            <p>メンバー全員で同じノートを書き足していきます。例:</p>
            <ul className="empty-state__examples">
              <li>他アプリケーションの情報</li>
              <li>ストレージ接続まわりの補足 (どこに何があるか)</li>
            </ul>
            <Link className="empty-state__cta" to="/edit-note">
              最初のノートを書く
            </Link>
          </div>
        )}

        {hasByline && (
          <p className="byline">
            {bylineEditor && <span>{bylineEditor}</span>}
            {bylineWhen && <span>{bylineWhen}</span>}
          </p>
        )}
      </div>

      {historyOpen && (
        <Suspense fallback={null}>
          <NoteHistoryModal
            slug="home"
            currentBody={data.exists ? data.body : null}
            onClose={() => setHistoryOpen(false)}
          />
        </Suspense>
      )}
    </>
  )
}
