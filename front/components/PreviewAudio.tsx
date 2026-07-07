import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { MediaAnalyze } from '../lib/api/types'
import { Waveform } from './Waveform'

type Analyze = z.infer<typeof MediaAnalyze>

interface Props {
  connId: string
  bucket: string
  k: string
  // tar 内エントリのとき: k = tar のキー、entryPath = tar 内パス
  entryPath?: string
}

export function PreviewAudio({ connId, bucket, k, entryPath }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [analyze, setAnalyze] = useState<Analyze | null>(null)
  const [analyzing, setAnalyzing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [showSpec, setShowSpec] = useState(false)

  const src = entryPath
    ? api.tarEntryUrl(connId, bucket, k, entryPath)
    : api.audioUrl(connId, bucket, k)

  // 解析はサーバー側キャッシュがあるので毎マウントで呼んでよい。ファイル切替時の
  // state リセットは呼び出し側 (key で再マウント) に任せ、ここでは同期 setState
  // で揃えない — effect 内の同期 setState は react-hooks/set-state-in-effect が
  // 検出するカスケード再レンダーの原因になるため。
  // 長尺はレスポンスまで時間がかかる — アンマウントで abort して ffmpeg を止める。
  useEffect(() => {
    const ctl = new AbortController()
    api.mediaAnalyze(connId, bucket, k, { entryPath, signal: ctl.signal })
      .then(r => setAnalyze(r))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError((e as Error).message)
      })
      .finally(() => setAnalyzing(false))
    return () => ctl.abort()
  }, [connId, bucket, k, entryPath])

  // 再生ヘッド追従 (rAF)。timeupdate はイベント間隔が粗く波形上でカクつく。
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const a = audioRef.current
      if (a && a.duration > 0) setProgress(a.currentTime / a.duration)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onSeek = (ratio: number): void => {
    const a = audioRef.current
    if (a && Number.isFinite(a.duration)) a.currentTime = ratio * a.duration
  }

  return (
    <div className="flex flex-col gap-2">
      <audio ref={audioRef} className="w-full" src={src} controls preload="metadata" />
      {analyzing && <p className="m-0 text-[12px] text-ink-7">解析中…</p>}
      {error && <p className="m-0 text-[12px] text-ink-7">波形を表示できません: {error}</p>}
      {analyze && analyze.peaks.length > 0 && (
        <Waveform peaks={analyze.peaks} progress={progress} onSeek={onSeek} />
      )}
      {analyze?.hasSpectrogram && (
        <div>
          <button
            type="button"
            className="ghost text-[11px]"
            onClick={() => setShowSpec(s => !s)}
          >
            {showSpec ? 'スペクトログラムを隠す' : 'スペクトログラムを表示'}
          </button>
          {showSpec && (
            <img
              className="mt-1 w-full"
              src={api.spectrogramUrl(connId, analyze.cacheKey)}
              alt="スペクトログラム"
            />
          )}
        </div>
      )}
    </div>
  )
}
