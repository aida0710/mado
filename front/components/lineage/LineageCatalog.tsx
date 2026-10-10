import { Fragment, useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react'
import { api } from '../../lib/api/client'
import type { RegistryDatasetSummary } from '../../lib/api/types'
import { isFromRowControl } from '../../lib/lineage/rowClick'

const PAGE_SIZE = 20
const SEARCH_DELAY_MS = 200

function datasetKey(dataset: RegistryDatasetSummary): string {
  return `${dataset.namespace}\u0000${dataset.name}`
}

interface Props {
  hasSelection: boolean
  onSelect: (dataset: RegistryDatasetSummary) => void
}

/**
 * 登録済みデータセットの一覧と検索。起点を選ぶと閉じる。
 * 640px 未満では説明とデータ形式を行の下に開く形にする (共通の部品の .responsive-table)。
 */
export function LineageCatalog({ hasSelection, onSelect }: Props) {
  const [open, setOpen] = useState(!hasSelection)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [offset, setOffset] = useState(0)
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set())
  const detailIdPrefix = useId()
  const [response, setResponse] = useState<{
    key: string
    results: RegistryDatasetSummary[]
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

  const select = (dataset: RegistryDatasetSummary) => {
    onSelect(dataset)
    setOpen(false)
  }
  const toggleRow = (key: string) => setOpenRows(current => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })

  return (
    <section className="lineage-catalog" aria-label="登録済みデータセット">
      <h2 className="lineage-catalog__heading">
        <button
          type="button"
          className="lineage-catalog__toggle"
          aria-expanded={expanded}
          onClick={() => setOpen(value => !value)}
        >
          {expanded
            ? <ChevronDown size={18} aria-hidden="true" />
            : <ChevronRight size={18} aria-hidden="true" />}
          登録一覧・検索
        </button>
      </h2>

      {expanded && (
        <div className="lineage-catalog__body">
          <div className="lineage-toolbar">
            <label className="lineage-search-field">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">データセットを検索</span>
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Podcast、英語、対話、s3://dataset/..."
                autoComplete="off"
              />
            </label>
            <span className="lineage-toolbar__status">{loading ? '検索中…' : `登録 ${total}件`}</span>
          </div>

          {error && <p className="notice error" role="alert">{error}</p>}
          {!loading && !error && results.length === 0 && (
            <p className="state-message">条件に合うデータセットはありません。</p>
          )}
          {results.length > 0 && (
            <div className="table-scroll">
              <table className="responsive-table">
                <thead>
                  <tr>
                    <th scope="col">データセット</th>
                    <th scope="col" className="lineage-catalog__secondary">説明</th>
                    <th scope="col" className="lineage-catalog__secondary">データ形式</th>
                    <th scope="col" className="numeric">バージョン</th>
                    <th scope="col" className="responsive-table-toggle lineage-catalog__row-toggle">
                      <span className="sr-only">詳細を表示</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((dataset, index) => {
                    const key = datasetKey(dataset)
                    const rowOpen = openRows.has(key)
                    const detailId = `${detailIdPrefix}-${index}`
                    const description = dataset.description ?? <span className="muted">説明は未登録です。</span>
                    const mediaType = dataset.mediaType ?? <span className="muted">データ形式未登録</span>
                    return (
                      <Fragment key={key}>
                        <tr
                          className="clickable-row"
                          onClick={event => { if (!isFromRowControl(event)) select(dataset) }}
                        >
                          <td>
                            <button type="button" className="link-button" onClick={() => select(dataset)}>
                              {dataset.displayName ?? dataset.name}
                            </button>
                            <small className="mono break-word">{dataset.namespace} / {dataset.name}</small>
                          </td>
                          <td className="lineage-catalog__secondary lineage-catalog__description">{description}</td>
                          <td className="lineage-catalog__secondary nowrap">{mediaType}</td>
                          <td className="numeric nowrap">{dataset.versionCount}件</td>
                          <td className="responsive-table-toggle lineage-catalog__row-toggle">
                            <button
                              type="button"
                              className="icon-button"
                              aria-expanded={rowOpen}
                              aria-controls={detailId}
                              aria-label={rowOpen ? '詳細を閉じる' : '詳細を表示'}
                              title={rowOpen ? '詳細を閉じる' : '詳細を表示'}
                              onClick={() => toggleRow(key)}
                            >
                              {rowOpen
                                ? <ChevronUp size={18} aria-hidden="true" />
                                : <ChevronDown size={18} aria-hidden="true" />}
                            </button>
                          </td>
                        </tr>
                        {rowOpen && (
                          <tr id={detailId} className="responsive-table-details lineage-catalog__details">
                            <td colSpan={3}>
                              <dl>
                                <div><dt>説明</dt><dd>{description}</dd></div>
                                <div><dt>データ形式</dt><dd>{mediaType}</dd></div>
                              </dl>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {results.length > 0 && (
            <div className="table-footer">
              <span>{start}–{end}</span>
              {total > PAGE_SIZE && (
                <span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="前へ"
                    title="前へ"
                    disabled={offset === 0 || loading}
                    onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}
                  ><ChevronLeft size={16} aria-hidden="true" /></button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="次へ"
                    title="次へ"
                    disabled={offset + results.length >= total || loading}
                    onClick={() => setOffset(value => value + PAGE_SIZE)}
                  ><ChevronRight size={16} aria-hidden="true" /></button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
