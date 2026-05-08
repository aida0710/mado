import { useEffect, useReducer, useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api/client'
import type { z } from 'zod'
import { TarPreview } from '../lib/api/types'
import { fmtSize } from '../lib/format'
import { TarEntryModal } from './TarEntryModal'

type Resp = z.infer<typeof TarPreview>
type Entry = Resp['entries'][number]

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
const DEFAULT_PAGE_SIZE = 10

const tableHeadClass =
  'px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'
const rowClass = 'cursor-pointer transition-colors hover:bg-ink-0 focus-visible:bg-ink-1'
const pagerBtnClass =
  'cursor-pointer bg-paper px-3 py-1 text-[12px] transition-colors ' +
  'hover:bg-ink-1 disabled:cursor-default disabled:opacity-40'

interface Progress {
  entries: number
  bytes: number
  requests: number
  mode: '' | 'range' | 'stream'
  startedAt: number
  elapsed: number
}

interface State {
  data: Resp | null
  offset: number
  pageSize: number
  error: string | null
  loading: boolean
  progress: Progress
}

type Action =
  | { type: 'startLoad' }
  | { type: 'setPageSize'; size: number }
  | { type: 'setMode'; mode: 'range' | 'stream' }
  | { type: 'incEntry' }
  | { type: 'progress'; bytes: number; requests?: number }
  | { type: 'tick'; elapsed: number }
  | { type: 'loadOk'; data: Resp }
  | { type: 'loadErr'; error: string }
  | { type: 'pagePrev' }
  | { type: 'pageNext' }

function makeInitial(): State {
  // 関数 initializer 内なので Date.now() を呼んでも render の純粋性を破らない。
  return {
    data: null,
    offset: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    error: null,
    loading: true,
    progress: { entries: 0, bytes: 0, requests: 0, mode: '', startedAt: Date.now(), elapsed: 0 },
  }
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'startLoad':
      return {
        ...s,
        data: null,
        loading: true,
        error: null,
        // Date.now() を reducer 内で呼ぶ: render 関数 / JSX から直接 reachable
        // ではないので react-doctor の hydration ルールを回避できる。
        progress: { entries: 0, bytes: 0, requests: 0, mode: '', startedAt: Date.now(), elapsed: 0 },
      }
    case 'setPageSize':
      // pageSize 変更時は offset を 0 にリセットし load を開始する。
      return {
        ...s,
        pageSize: a.size,
        offset: 0,
        data: null,
        loading: true,
        error: null,
        progress: { entries: 0, bytes: 0, requests: 0, mode: '', startedAt: Date.now(), elapsed: 0 },
      }
    case 'setMode':
      return { ...s, progress: { ...s.progress, mode: a.mode } }
    case 'incEntry':
      return { ...s, progress: { ...s.progress, entries: s.progress.entries + 1 } }
    case 'progress':
      return {
        ...s,
        progress: {
          ...s.progress,
          bytes: a.bytes,
          requests: a.requests ?? s.progress.requests,
        },
      }
    case 'tick':
      return { ...s, progress: { ...s.progress, elapsed: a.elapsed } }
    case 'loadOk':
      return { ...s, data: a.data, loading: false }
    case 'loadErr':
      return { ...s, error: a.error, loading: false }
    case 'pagePrev':
      return { ...s, offset: Math.max(0, s.offset - s.pageSize) }
    case 'pageNext':
      return { ...s, offset: s.offset + s.pageSize }
  }
}

export function PreviewArchive({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  const [openedEntry, setOpenedEntry] = useState<Entry | null>(null)
  const [state, dispatch] = useReducer(reducer, undefined, makeInitial)
  const { data, offset, pageSize, error, loading, progress } = state

  // 当該アーカイブのキャッシュを丸ごと破棄して同じページを再取得。
  const forceRefresh = (): void => {
    api.invalidateTarPreview(connId, bucket, k)
    dispatch({ type: 'startLoad' })
    api.tarPreview(connId, bucket, k, { limit: pageSize, offset })
      .then(r => dispatch({ type: 'loadOk', data: r }))
      .catch((e: Error) => dispatch({ type: 'loadErr', error: e.message }))
  }

  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'startLoad' })

    api.tarPreview(connId, bucket, k, { limit: pageSize, offset }, {
      onMode: (mode: 'range' | 'stream') => {
        if (!cancelled) dispatch({ type: 'setMode', mode })
      },
      onEntry: () => {
        if (!cancelled) dispatch({ type: 'incEntry' })
      },
      onProgress: ({ bytes, requests }: { bytes: number; requests?: number }) => {
        if (!cancelled) dispatch({ type: 'progress', bytes, requests })
      },
    })
      .then(r => { if (!cancelled) dispatch({ type: 'loadOk', data: r }) })
      .catch((e: Error) => { if (!cancelled) dispatch({ type: 'loadErr', error: e.message }) })
    return () => { cancelled = true }
  }, [connId, bucket, k, offset, pageSize])

  // ローディング中に経過時間カウンターを更新する。
  useEffect(() => {
    if (data || error) return
    const startedAt = progress.startedAt
    const t = setInterval(() => {
      dispatch({ type: 'tick', elapsed: (Date.now() - startedAt) / 1000 })
    }, 200)
    return () => clearInterval(t)
  }, [data, error, progress.startedAt])

  const ruleStyle = { border: '1px solid var(--color-rule-strong)', borderRadius: 'var(--radius-1)' } as const

  const sizeSelect = (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2">
        <span
          className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-ink-7"
        >
          表示件数
        </span>
        <select
          className="cursor-pointer bg-paper px-2 py-1 text-[12px] disabled:cursor-default disabled:opacity-50"
          style={ruleStyle}
          value={pageSize}
          onChange={e => dispatch({ type: 'setPageSize', size: Number(e.target.value) })}
          disabled={loading}
        >
          {PAGE_SIZE_OPTIONS.map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <button
        className={pagerBtnClass}
        style={ruleStyle}
        onClick={forceRefresh}
        disabled={loading}
        title="キャッシュを破棄して再読み込み"
        aria-label="再読み込み"
      >
        <span aria-hidden>↻</span>
      </button>
    </div>
  )

  if (error) return <p className="error">{error}</p>
  if (!data) {
    const modeLabel =
      progress.mode === 'range'  ? 'range request'
      : progress.mode === 'stream' ? 'streaming decode'
      : 'connecting'
    return (
      <div>
        <div className="mb-3 flex items-center justify-between">{sizeSelect}</div>
        <p
          className="text-[13px] text-ink-7"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          <span>{modeLabel}…</span>{' '}
          <span className="tabular-nums">{progress.entries}</span>
          {' 件 · '}
          <span className="tabular-nums">{fmtSize(progress.bytes)}</span>
          {progress.requests > 0 && (
            <>
              {' · '}
              <span className="tabular-nums">{progress.requests}</span>
              {' req'}
            </>
          )}
          {' · '}
          <span className="tabular-nums">{progress.elapsed.toFixed(1)}</span>
          {'s'}
        </p>
      </div>
    )
  }

  const start = data.offset + 1
  const end = data.offset + data.entries.length
  const page = Math.floor(data.offset / pageSize) + 1

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">{sizeSelect}</div>
      {data.truncated && (
        <p className="text-[12px] text-ink-7">
          バイト上限に到達しました。これ以降は読み込めません。
        </p>
      )}
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-rule-strong)' }}>
            <th className={tableHeadClass}>Name</th>
            <th className={`${tableHeadClass} w-px whitespace-nowrap text-right`}>Size</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map(e => (
            <tr
              key={e.name}
              className={rowClass}
              role="button"
              tabIndex={0}
              style={{ borderBottom: '1px solid var(--rule)' }}
              onClick={() => setOpenedEntry(e)}
              onKeyDown={(ev: KeyboardEvent<HTMLTableRowElement>) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  setOpenedEntry(e)
                }
              }}
            >
              <td
                className="p-2"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}
              >
                {e.name}
              </td>
              <td
                className="w-px whitespace-nowrap p-2 text-right text-ink-7 tabular-nums"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              >
                {fmtSize(e.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="flex items-center justify-center gap-3 py-3 text-[12px] tabular-nums text-ink-7"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <button
          className={pagerBtnClass}
          style={ruleStyle}
          onClick={() => dispatch({ type: 'pagePrev' })}
          disabled={offset === 0 || loading}
        >
          ← Prev
        </button>
        <span>
          {data.entries.length > 0
            ? `${start}-${end}`
            : 'no entries'}
          {' / page '}{page}
          {data.hasMore || data.truncated ? '+' : ''}
        </span>
        <button
          className={pagerBtnClass}
          style={ruleStyle}
          onClick={() => dispatch({ type: 'pageNext' })}
          disabled={data.truncated || loading || data.entries.length === 0}
        >
          Next →
        </button>
      </div>
      {openedEntry && (
        <TarEntryModal
          connId={connId}
          bucket={bucket}
          archiveKey={k}
          entry={openedEntry}
          onClose={() => setOpenedEntry(null)}
        />
      )}
    </div>
  )
}
