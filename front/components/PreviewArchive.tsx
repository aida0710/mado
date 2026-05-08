import { useEffect, useState, type KeyboardEvent } from 'react'
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

  // ファイルまたはページサイズが変わったときにページ1にリセットする。
  useEffect(() => { setOffset(0) }, [connId, bucket, k, pageSize])

  // 当該アーカイブのキャッシュを丸ごと破棄して同じページを再取得。
  const forceRefresh = (): void => {
    api.invalidateTarPreview(connId, bucket, k)
    // 再 fetch を効かせるため state を一度クリアする。useEffect の依存
    // (connId/bucket/k/offset/pageSize) は変わらないので、
    // setData(null) で「loading 状態」に落とせば次のレンダで fetch が走る。
    setData(null)
    setError(null)
    setLoading(true)
    const startedAt = Date.now()
    setProgress({ entries: 0, bytes: 0, requests: 0, mode: '', startedAt, elapsed: 0 })
    api.tarPreview(connId, bucket, k, { limit: pageSize, offset })
      .then(r => setData(r))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

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

  // ローディング中に経過時間カウンターを更新する。
  useEffect(() => {
    if (data || error) return
    const t = setInterval(() => {
      setProgress(p => ({ ...p, elapsed: (Date.now() - p.startedAt) / 1000 }))
    }, 200)
    return () => clearInterval(t)
  }, [data, error])

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
          onChange={e => setPageSize(Number(e.target.value))}
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
      <div className="overflow-x-auto">
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
                  className="px-2 py-2"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}
                >
                  {e.name}
                </td>
                <td
                  className="w-px whitespace-nowrap px-2 py-2 text-right text-ink-7 tabular-nums"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                >
                  {fmtSize(e.size)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="flex items-center justify-center gap-3 py-3 text-[12px] tabular-nums text-ink-7"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <button
          className={pagerBtnClass}
          style={ruleStyle}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
          disabled={offset === 0 || loading}
        >
          ← Prev
        </button>
        <span>
          {data.entries.length > 0
            ? `${start}–${end}`
            : 'no entries'}
          {' / page '}{page}
          {data.hasMore || data.truncated ? '+' : ''}
        </span>
        <button
          className={pagerBtnClass}
          style={ruleStyle}
          onClick={() => setOffset(offset + pageSize)}
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
