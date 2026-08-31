import { useEffect, useState } from 'react'
import { api } from '../../lib/api/client'
import type { DatasetCatalogItem } from '../../lib/api/types'

const PAGE_SIZE = 20
const SEARCH_DELAY_MS = 200

interface Props {
  hasSelection: boolean
  onSelect: (dataset: DatasetCatalogItem) => void
}

export function LineageCatalog({ hasSelection, onSelect }: Props) {
  const [open, setOpen] = useState(!hasSelection)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [offset, setOffset] = useState(0)
  const [response, setResponse] = useState<{
    key: string
    results: DatasetCatalogItem[]
    total: number
    error: string | null
  } | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0)
      setSubmitted(query.trim())
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const expanded = open
  const requestKey = `${submitted}\u0000${offset}`

  useEffect(() => {
    if (!expanded) return
    let current = true
    api.lineageCatalog({ q: submitted, limit: PAGE_SIZE, offset }).then(
      response => {
        if (!current) return
        setResponse({ key: requestKey, results: response.results, total: response.totalCount, error: null })
      },
      (reason: Error) => {
        if (!current) return
        setResponse({ key: requestKey, results: [], total: 0, error: reason.message })
      },
    )
    return () => { current = false }
  }, [expanded, submitted, offset, requestKey])

  const currentResponse = response?.key === requestKey ? response : null
  const results = currentResponse?.results ?? []
  const total = currentResponse?.total ?? 0
  const error = currentResponse?.error ?? null
  const loading = expanded && currentResponse === null

  const start = total === 0 ? 0 : offset + 1
  const end = Math.min(offset + results.length, total)

  return (
    <section className="lineage-catalog" aria-label="登録済みデータセット">
      <button
        type="button"
        className="lineage-catalog__toggle"
        aria-expanded={expanded}
        onClick={() => setOpen(value => !value)}
      >
        <span>登録一覧・検索</span>
        <span aria-hidden>{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="lineage-catalog__body">
          <label className="lineage-catalog__search">
            <span>データセットを検索</span>
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Podcast、英語、対話、s3://dataset/..."
              autoComplete="off"
            />
          </label>

          <div className="lineage-catalog__meta">
            <span>{loading ? '検索中…' : `登録 ${total}件`}</span>
            {total > 0 && <span>{start}–{end}</span>}
          </div>

          {error && <p className="error" role="alert">{error}</p>}
          {!loading && !error && results.length === 0 && (
            <p className="lineage-catalog__empty">条件に合うデータセットはありません。</p>
          )}
          <ul className="lineage-catalog__results">
            {results.map(dataset => (
              <li key={`${dataset.namespace}\u0000${dataset.name}`}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(dataset)
                    setOpen(false)
                  }}
                >
                  <span className="lineage-catalog__title">
                    {dataset.displayName ?? dataset.name}
                  </span>
                  <span className="lineage-catalog__description">
                    {dataset.description ?? '説明は未登録です。'}
                  </span>
                  <span className="lineage-catalog__facts">
                    {dataset.mediaType ?? 'データ形式未登録'} · バージョン {dataset.versionCount}件
                  </span>
                  <span className="lineage-catalog__identity">
                    {dataset.namespace} / {dataset.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {total > PAGE_SIZE && (
            <div className="lineage-catalog__pager">
              <button
                type="button"
                className="ghost"
                disabled={offset === 0 || loading}
                onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}
              >前へ</button>
              <button
                type="button"
                className="ghost"
                disabled={offset + results.length >= total || loading}
                onClick={() => setOffset(value => value + PAGE_SIZE)}
              >次へ</button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
