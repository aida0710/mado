import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { api } from '../lib/api/client'
import type { z } from 'zod'
import { Readme } from '../lib/api/types'

// 編集 UI と履歴ビューワは「ボタンを押した後にだけ」マウントされる。
// React.lazy() で別チャンクに分け、初回ロード時の JS / CSS 量を絞る。
const MarkdownEditor = lazy(() =>
  import('./MarkdownEditor').then(m => ({ default: m.MarkdownEditor })),
)
const ReadmeHistoryModal = lazy(() =>
  import('./ReadmeHistoryModal').then(m => ({ default: m.ReadmeHistoryModal })),
)

type ReadmeData = z.infer<typeof Readme>

interface Props {
  connId: string
  bucket: string
  prefix: string
}

export function ReadmeView({ connId, bucket, prefix }: Props) {
  const [data, setData] = useState<ReadmeData | null>(null)
  const [editing, setEditing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  // refresh: 通常のリロード。キャッシュが効いていれば即時に解決する。
  // forceRefresh: 🔄 ボタンから呼ぶ。キャッシュを破棄してから fetch する
  // (例: 他人がダッシュボード経由で編集した、aws cli で直接書き換えた、等)。
  const refresh = useCallback(() => {
    api.readme(connId, bucket, prefix).then(setData).catch(() => setData({ exists: false }))
  }, [connId, bucket, prefix])

  const forceRefresh = useCallback(() => {
    api.invalidateReadme(connId, bucket, prefix)
    refresh()
  }, [connId, bucket, prefix, refresh])

  useEffect(() => { refresh() }, [refresh])

  if (!data) return null
  return (
    <section
      className="pb-5"
      style={{ borderBottom: '1px solid var(--rule)' }}
      data-color-mode="light"
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2 mb-3">
        <p className="kicker m-0">S3 README</p>
        <span className="ml-auto flex items-center gap-2">
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
          <button
            className="ghost"
            onClick={forceRefresh}
            title="キャッシュを破棄して再読み込み"
            aria-label="更新"
          >
            <span aria-hidden>↻</span>
          </button>
          {data.exists && data.last_editor && (
            <span className="text-[12px] text-ink-7">
              last by <span className="font-medium text-ink-11">{data.last_editor}</span>
            </span>
          )}
        </span>
      </header>
      {data.exists ? (
        <article className="article mt-1">
          <MDEditor.Markdown source={data.body} rehypePlugins={[[rehypeSanitize]]} />
        </article>
      ) : (
        <p className="text-[13px] text-ink-7">
          README なし
        </p>
      )}
      {editing && (
        <Suspense fallback={null}>
          <MarkdownEditor
            title={`Edit README — ${prefix || '(root)'}`}
            initialBody={data.exists ? data.body : ''}
            initialEditor={data.exists ? (data.last_editor ?? '') : ''}
            onSave={(body, editor) =>
              api.putReadme(connId, bucket, prefix, body, editor).then(() => undefined)
            }
            onSaved={() => { setEditing(false); refresh() }}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      )}
      {historyOpen && (
        <Suspense fallback={null}>
          <ReadmeHistoryModal
            connId={connId}
            bucket={bucket}
            prefix={prefix}
            currentBody={data.exists ? data.body : null}
            onClose={() => setHistoryOpen(false)}
          />
        </Suspense>
      )}
    </section>
  )
}
