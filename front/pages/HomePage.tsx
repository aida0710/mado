import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { Note } from '../lib/api/types'

// 編集モーダルと履歴モーダルはクリック後にしか描画されないので、
// React.lazy() で別チャンクに切り出す。MarkdownEditor チャンクには
// CodeMirror ベースの重量級 UI と専用 CSS が同梱される。
const MarkdownEditor = lazy(() =>
  import('../components/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })),
)
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
  const [editing, setEditing] = useState(false)
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
          <button className="ghost" onClick={() => setEditing(true)}>
            <span aria-hidden>✎</span>
            {data.exists ? '編集' : '作成'}
          </button>
          <button
            className="ghost"
            onClick={() => setHistoryOpen(true)}
            title="編集履歴を表示"
          >
            <span aria-hidden>⏱</span>
            履歴
          </button>
          <p className="page-head__sub">Mado 全体で 1 つの共有メモ — LAN 内の誰でも編集できます</p>
        </header>

        {isPresent ? (
          <article className="article mt-2">
            <MDEditor.Markdown source={data.body} rehypePlugins={[[rehypeSanitize]]} />
          </article>
        ) : (
          <div className="empty-state">
            <h3>まだ何も書かれていません</h3>
            <p>
              ここはチーム全員で共有する一枚のノートです。<br />
              最初の数行を書きはじめてみましょう。
            </p>
            <button className="empty-state__cta" onClick={() => setEditing(true)}>
              最初のノートを書く
            </button>
          </div>
        )}

        {hasByline && (
          <p className="byline">
            {bylineEditor && <span>{bylineEditor}</span>}
            {bylineWhen && <span>{bylineWhen}</span>}
          </p>
        )}
      </div>

      {editing && (
        <Suspense fallback={null}>
          <MarkdownEditor
            title="Edit Home"
            initialBody={data.exists ? data.body : ''}
            initialEditor={data.exists ? (data.last_editor ?? '') : ''}
            onSave={(body, editor) =>
              api.putNote('home', body, editor).then(() => undefined)
            }
            onSaved={() => { setEditing(false); refresh() }}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      )}
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
