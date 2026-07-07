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

  // stale レスポンス防御用の世代カウンタ。StorageBrowser 内でこのパネルは
  // prefix 切替でも remount されないため、旧 target 向けの in-flight 応答が
  // 後着で新 target の state を上書きしないよう、応答適用時に世代を照合する。
  // (アンマウント後の応答は React 18+ では setState が no-op なので世代照合不要。)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    // target はオブジェクトなので中身 (prefix / tarKey) で依存させる
  }, [connId, bucket, target.prefix, target.tarKey])

  // async/await ではなく .then/.catch チェーンにする: await 後の setState は
  // effect から呼んだとき react-hooks/set-state-in-effect に静的解析で抵触するが、
  // promise コールバック内の setState は抵触しない。返す Promise は reject しない。
  const refresh = useCallback((): Promise<void> => {
    const gen = generation.current
    return api.scanStatus(connId, bucket, target)
      .then(s => {
        if (gen !== generation.current) return
        setStatus(s)
        setError(null)
      })
      .catch((e: unknown) => {
        if (gen === generation.current) setError((e as Error).message)
      })
    // target はオブジェクトなので中身で依存させる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, target.prefix, target.tarKey])

  // open になったら取得する。stale 応答は refresh 内の世代照合で破棄される。
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

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

  // scanStart 失敗時は未処理 rejection にせず既存の error state に流して表示する
  // (refresh は reject しないので、この catch が拾うのは scanStart の失敗のみ)。
  const start = async (): Promise<void> => {
    try {
      await api.scanStart(connId, { bucket, ...target })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
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
