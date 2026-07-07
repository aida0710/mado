import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { ScanStatus } from '../lib/api/types'

type Status = z.infer<typeof ScanStatus>

interface Props {
  connId: string
  bucket: string
  target: { prefix?: string; tarKey?: string }
}

interface StatsShape {
  fileCount: number
  totalDurationSec: number
  durationHistogram: Array<{ le: number | null; count: number }>
  textFileCount: number
  vocabSize: number
  vocabTruncated: boolean
  charSet: number
  topWords: Array<[string, number]>
  truncated: boolean
}

const fmtDuration = (sec: number): string => {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`
}

export function DatasetStatsPanel({ connId, bucket, target }: Props) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.scanStatus(connId, bucket, target))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
    // target はオブジェクトなので中身で依存させる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, target.prefix, target.tarKey])

  // open になったら取得する。PreviewText 等と同様に .then/.catch を
  // effect 本体に直接書く (refresh() を直接呼ぶと、setState が effect 内で
  // 同期的に呼ばれたとみなされ react-hooks/set-state-in-effect に抵触するため)。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.scanStatus(connId, bucket, target)
      .then(s => {
        if (cancelled) return
        setStatus(s)
        setError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => { cancelled = true }
    // target はオブジェクトなので中身で依存させる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connId, bucket, target.prefix, target.tarKey])

  // 実行中だけ 1 秒ポーリング
  const running = status?.job != null
    && (status.job.status === 'queued' || status.job.status === 'processing')
  useEffect(() => {
    if (!open || !running) return
    timerRef.current = setInterval(() => void refresh(), 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [open, running, refresh])

  const start = async (): Promise<void> => {
    await api.scanStart(connId, { bucket, ...target })
    await refresh()
  }
  const cancel = async (): Promise<void> => {
    if (status?.job) {
      // scan-cancel は既に終了したジョブに対して 404 を返す (非冪等)。
      // ここでエラートーストにせず静かに refresh し、次の scanStatus で
      // 真の状態を反映する。
      try {
        await api.scanCancel(connId, status.job.id)
      } catch {
        // 意図的に無視する
      }
      await refresh()
    }
  }

  const stats = status?.stats as unknown as StatsShape | null
  const maxCount = stats ? Math.max(1, ...stats.durationHistogram.map(b => b.count)) : 1

  return (
    <details
      className="mb-3 text-[13px]"
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-7">
        データセット統計
      </summary>
      <div className="mt-2 flex flex-col gap-2 pl-1">
        {error && <p className="m-0 text-ink-7">{error}</p>}
        {status && !running && !stats && (
          <button type="button" className="ghost self-start" onClick={() => void start()}>
            スキャンを実行
          </button>
        )}
        {status?.job?.status === 'error' && (
          <p className="m-0 text-ink-7">前回のスキャンが失敗しました: {status.job.error}</p>
        )}
        {running && (
          <div className="flex items-center gap-3">
            <span className="text-ink-7">
              {status!.job!.status === 'queued'
                ? 'キュー待ち…'
                : status!.job!.progress
                  ? status!.job!.progress.filesTotal >= 0
                    ? `解析中… ${status!.job!.progress.filesDone} / ${status!.job!.progress.filesTotal}`
                    : `解析中… ${status!.job!.progress.filesDone} ファイル処理済み`
                  : '解析中…'}
            </span>
            <button type="button" className="ghost text-[11px]" onClick={() => void cancel()}>
              キャンセル
            </button>
          </div>
        )}
        {stats && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-ink-11">
              {fmtDuration(stats.totalDurationSec)}・{stats.fileCount} ファイル・
              テキスト {stats.textFileCount}・語彙 {stats.vocabSize}{stats.vocabTruncated ? '+' : ''}・
              文字種 {stats.charSet}
              {stats.truncated && <span className="text-ink-7">（上限で打ち切り）</span>}
            </p>
            <div className="flex flex-col gap-0.5">
              {stats.durationHistogram.map(b => (
                <div key={String(b.le)} className="flex items-center gap-2">
                  <span className="w-14 text-right text-[11px] tabular-nums text-ink-7">
                    {b.le != null ? `≤${b.le}s` : '60s+'}
                  </span>
                  <div className="h-3 flex-1">
                    <div
                      className="h-full bg-ink-6"
                      style={{ width: `${(b.count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 text-[11px] tabular-nums text-ink-7">{b.count}</span>
                </div>
              ))}
            </div>
            {stats.topWords.length > 0 && (
              <p className="m-0 text-[12px] text-ink-7">
                頻出語: {stats.topWords.slice(0, 10).map(([w, n]) => `${w} (${n})`).join(', ')}
              </p>
            )}
            <button type="button" className="ghost self-start text-[11px]" onClick={() => void start()}>
              再スキャン
            </button>
          </div>
        )}
      </div>
    </details>
  )
}
