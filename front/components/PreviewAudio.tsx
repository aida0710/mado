import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { MediaAnalyze } from '../lib/api/types'
import { formatAudioInfoLines } from '../lib/audioInfo'
import { useAudioSrc } from '../lib/useAudioSrc'
import { Waveform } from './Waveform'
import { useCapabilities } from '../lib/useCapabilities'

type Analyze = z.infer<typeof MediaAnalyze>

interface Props {
  connectionId: string
  bucket: string
  k: string
  // tar 内エントリのとき: k = tar のキー、entryPath = tar 内パス
  entryPath?: string
}

/**
 * 音声のプレビュー。再生の操作、波形とスペクトログラムを 1 つの枠に重ねた時間軸、
 * 形式などの情報の行を縦に並べる。
 */
export function PreviewAudio({ connectionId, bucket, k, entryPath }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [analyze, setAnalyze] = useState<Analyze | null>(null)
  const [analyzing, setAnalyzing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const caps = useCapabilities(connectionId)

  // 再生の部分取得と波形解析の全量取得は別の経路で行う。
  const { src, loading: srcLoading, error: srcError } = useAudioSrc({ connectionId, bucket, key: k, entryPath })

  // 解析はサーバー側キャッシュがあるので毎マウントで呼んでよい。ファイル切替時の
  // state リセットは呼び出し側 (key で再マウント) に任せ、ここでは同期 setState
  // で揃えない — effect 内の同期 setState は react-hooks/set-state-in-effect が
  // 検出するカスケード再レンダーの原因になるため。
  // 長尺はレスポンスまで時間がかかる — アンマウントで abort して ffmpeg を止める。
  //
  // 音声情報が無効な接続では解析そのものを呼ばない。解析はファイル全体を読むので、
  // ここで止めないと「オフにしたのに毎回フル DL される」ことになる。
  useEffect(() => {
    if (!caps.audioInfo) return
    const ctl = new AbortController()
    api.mediaAnalyze({ connectionId, bucket, key: k, entryPath, signal: ctl.signal })
      .then(r => setAnalyze(r))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError((e as Error).message)
      })
      .finally(() => setAnalyzing(false))
    return () => ctl.abort()
  }, [connectionId, bucket, k, entryPath, caps.audioInfo])

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

  const showWaveform = analyze != null && analyze.peaks.length > 0
  const showSpectrogram = analyze?.hasSpectrogram === true && caps.audioSpectrogram
  const lines = analyze ? infoLines(analyze) : []

  return (
    <div className="preview-stack preview-audio">
      {srcLoading && <p className="muted">音声を取得中…</p>}
      {srcError && <p className="notice error">音声を取得できません: {srcError}</p>}
      {src && <audio ref={audioRef} src={src} controls preload="metadata" />}
      {/* analyzing は初期値 true のまま据え置く (effect 内の同期 setState は
          react-hooks/set-state-in-effect に引っかかる) ので、権限側で出し分ける。 */}
      {analyzing && caps.audioInfo && <p className="muted">解析中…</p>}
      {error && <p className="preview-error">波形を表示できません: {error}</p>}
      {(showWaveform || showSpectrogram) && (
        <div className="preview-audio-timeline">
          {showWaveform && <Waveform peaks={analyze.peaks} progress={progress} onSeek={onSeek} />}
          {showSpectrogram && (
            <img
              className="preview-spectrogram"
              src={api.spectrogramUrl(connectionId, analyze.cacheKey)}
              alt="スペクトログラム"
            />
          )}
        </div>
      )}
      {lines.length > 0 && (
        <div className="preview-audio-info">
          {lines.map(line => <p key={line} className="muted mono">{line}</p>)}
        </div>
      )}
    </div>
  )
}

// meta が null の場合 (旧 API 互換 / 未解析) は空配列 → 情報行を出さない。
function infoLines(analyze: Analyze): string[] {
  return formatAudioInfoLines(analyze.meta, analyze.durationSec, analyze.sampleRate)
}
