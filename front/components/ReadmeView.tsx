import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { api } from '../lib/api/client'
import type { z } from 'zod'
import { Readme } from '../lib/api/types'
import { encPath } from '../lib/route'

// 履歴ビューワは「ボタンを押した後にだけ」マウントされる。
// React.lazy() で別チャンクに分け、初回ロード時の JS / CSS 量を絞る。
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
  const [historyOpen, setHistoryOpen] = useState(false)
  // README プレビューは普段は 15 行で打ち切り。長い時だけ「すべて表示」が出る。
  // フォントサイズは HomePage と同じ (`.markdown-body` のベース 17px) — ここでは
  // 折りたたみ機能だけ載せる。
  const [expanded, setExpanded] = useState(false)
  const [needsExpand, setNeedsExpand] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

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

  // 表示対象が prefix を跨いだら expand 状態をリセット (別ディレクトリでは別カウント)。
  useEffect(() => { setExpanded(false) }, [connId, bucket, prefix])

  // 折りたたみ中に「内容が 15 行を超えているか」を判定。展開中は再測定しない
  // (overflow が消えてもボタンを出し続けるため)。ResizeObserver で画面幅変化にも追従。
  const currentBody = data?.exists ? data.body : ''
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const check = () => {
      if (expanded) return
      setNeedsExpand(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [currentBody, expanded])

  if (!data) return null

  // 編集ページへの URL — bucket は単一セグメントなので encodeURIComponent で十分。
  // prefix は `/` を含み得るので encPath で path segment ごとに encode。
  const editHref = `/storage/${encodeURIComponent(connId)}/edit-readme/${encodeURIComponent(bucket)}/${encPath(prefix)}`

  return (
    <section
      className="pb-5"
      style={{ borderBottom: '1px solid var(--rule)' }}
      data-color-mode="light"
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2 mb-3">
        <p className="kicker m-0">S3 README</p>
        <span className="ml-auto flex items-center gap-2">
          <Link className="ghost" to={editHref}>
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
          <div
            ref={bodyRef}
            className={`markdown-body${expanded ? '' : ' is-collapsed'}`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
            >
              {data.body}
            </ReactMarkdown>
          </div>
          {(needsExpand || expanded) && (
            <button
              type="button"
              className="markdown-body__expand"
              onClick={() => setExpanded(e => !e)}
              aria-expanded={expanded}
            >
              {expanded ? '▲ 折りたたむ' : '▼ すべて表示'}
            </button>
          )}
        </article>
      ) : (
        <p className="text-[13px] text-ink-7">
          README なし
        </p>
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
