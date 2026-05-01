import { useEffect, useState, type KeyboardEvent } from 'react'
import { api } from '../api/client'
import type { z } from 'zod'
import { TarPreview } from '../api/types'
import { fmtSize } from '../lib/format'
import { TarEntryModal } from './TarEntryModal'

type Resp = z.infer<typeof TarPreview>
type Entry = Resp['entries'][number]

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
const DEFAULT_PAGE_SIZE = 10

const tableCellClass = 'px-2 py-1 border-b border-ink-1'
const rowClass = 'cursor-pointer transition-colors hover:bg-ink-0 focus-visible:bg-ink-1'
const pagerBtnClass =
  'cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors ' +
  'hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40'

export function PreviewArchive({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  const [openedEntry, setOpenedEntry] = useState<Entry | null>(null)
  const [data, setData] = useState<Resp | null>(null)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({
    entries: 0,
    bytes: 0,
    requests: 0,
    mode: '' as '' | 'range' | 'stream',
    startedAt: Date.now(),
    elapsed: 0,
  })

  // Reset to page 1 whenever the file or page size changes.
  useEffect(() => { setOffset(0) }, [connId, bucket, k, pageSize])

  useEffect(() => {
    let cancelled = false
    const startedAt = Date.now()
    setLoading(true)
    setError(null)
    setData(null)
    setProgress({ entries: 0, bytes: 0, requests: 0, mode: '', startedAt, elapsed: 0 })

    api.tarPreview(connId, bucket, k, { limit: pageSize, offset }, {
      onMode: (mode: 'range' | 'stream') => {
        if (!cancelled) setProgress(p => ({ ...p, mode }))
      },
      onEntry: () => {
        if (!cancelled) setProgress(p => ({ ...p, entries: p.entries + 1 }))
      },
      onProgress: ({ bytes, requests }: { bytes: number; requests?: number }) => {
        if (!cancelled) {
          setProgress(p => ({
            ...p,
            bytes,
            requests: requests ?? p.requests,
          }))
        }
      },
    })
      .then(r => { if (!cancelled) setData(r) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, bucket, k, offset, pageSize])

  // Tick the elapsed counter while loading.
  useEffect(() => {
    if (data || error) return
    const t = setInterval(() => {
      setProgress(p => ({ ...p, elapsed: (Date.now() - p.startedAt) / 1000 }))
    }, 200)
    return () => clearInterval(t)
  }, [data, error])

  const sizeSelect = (
    <label className="flex items-center gap-2">
      <span className="text-xs text-ink-7">表示件数</span>
      <select
        className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-2 py-1 disabled:cursor-default disabled:opacity-50"
        value={pageSize}
        onChange={e => setPageSize(Number(e.target.value))}
        disabled={loading}
      >
        {PAGE_SIZE_OPTIONS.map(n => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  )

  if (error) return <p className="error">{error}</p>
  if (!data) {
    const modeLabel =
      progress.mode === 'range'  ? 'range request'
      : progress.mode === 'stream' ? 'streaming decode'
      : 'connecting'
    return (
      <div>
        <div className="mb-2 flex items-center justify-between">{sizeSelect}</div>
        <p className="text-ink-7">
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
      <div className="mb-2 flex items-center justify-between">{sizeSelect}</div>
      {data.truncated && (
        <p className="text-ink-7">
          バイト上限に到達しました。これ以降は読み込めません。
        </p>
      )}
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="border-b border-ink-2 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-ink-7">Name</th>
            <th className="w-px whitespace-nowrap border-b border-ink-2 px-2 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-ink-7">Size</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map(e => (
            <tr
              key={e.name}
              className={rowClass}
              role="button"
              tabIndex={0}
              onClick={() => setOpenedEntry(e)}
              onKeyDown={(ev: KeyboardEvent<HTMLTableRowElement>) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  setOpenedEntry(e)
                }
              }}
            >
              <td className={tableCellClass}>{e.name}</td>
              <td className={`${tableCellClass} w-px whitespace-nowrap text-right text-ink-7 tabular-nums`}>
                {fmtSize(e.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-center gap-3 py-3 tabular-nums">
        <button
          className={pagerBtnClass}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
          disabled={offset === 0 || loading}
        >← Prev</button>
        <span>
          {data.entries.length > 0
            ? `${start}–${end}`
            : 'no entries'}
          {' / page '}{page}
          {data.hasMore || data.truncated ? '+' : ''}
        </span>
        <button
          className={pagerBtnClass}
          onClick={() => setOffset(offset + pageSize)}
          disabled={data.truncated || loading || data.entries.length === 0}
        >Next →</button>
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
