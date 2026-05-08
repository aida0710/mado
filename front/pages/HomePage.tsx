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

  // string | null を返す軽量計算 — useMemo の deps 比較コストの方が
  // 高くつくので素直にレンダ中に派生させる。
  const byline = data?.exists
    ? [data.last_editor, data.last_edited_at && formatByline(data.last_edited_at)]
        .filter(Boolean)
        .join(' · ') || null
    : null

  if (!data) return null

  const isPresent = data.exists && data.body.trim().length > 0

  return (
    <>
      <div data-color-mode="light">
        <header className="page-head">
          <h2>Team note</h2>
          <button className="ghost" onClick={() => setEditing(true)}>
            {data.exists ? '✎ 編集' : '✎ 作成'}
          </button>
          <button
            className="ghost"
            onClick={() => setHistoryOpen(true)}
            title="編集履歴を表示"
          >
            ⏱ 履歴
          </button>
          <span className="basis-full text-xs text-ink-7">Mado 全体で 1 つの共有メモ</span>
        </header>

        {isPresent ? (
          <article>
            <MDEditor.Markdown source={data.body} rehypePlugins={[[rehypeSanitize]]} />
          </article>
        ) : (
          <div className="empty-state">
            <p className="text-ink-7">まだホームノートがありません。</p>
            <button className="empty-state__cta" onClick={() => setEditing(true)}>
              最初のノートを書く
            </button>
          </div>
        )}

        {byline && (
          <footer
            className={
              "mt-8 text-center text-xs text-ink-7 " +
              "before:mx-3 before:inline-block before:h-px before:w-6 before:bg-ink-3 before:align-middle " +
              "after:mx-3 after:inline-block after:h-px after:w-6 after:bg-ink-3 after:align-middle"
            }
          >
            <span>{byline}</span>
          </footer>
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
