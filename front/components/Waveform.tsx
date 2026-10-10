import { useCallback, useEffect, useRef } from 'react'
import { useDocumentTheme } from '../lib/useDocumentTheme'

interface Props {
  peaks: Array<[number, number]>
  // 0〜1 の再生位置。再生ヘッド線 + 再生済み領域の色分けに使う。
  progress: number
  onSeek?: (ratio: number) => void
  height?: number
  // ピーク描画幅の全幅に対する比 (0〜1、既定 1)。デッキで各トラックの長さ /
  // maxDuration を渡すと、短いトラックは左寄せ + 右側空白になり、全トラックの
  // 再生ヘッド (progress は全幅比のまま) が水平に揃う (0 パディングの可視化)。
  durationRatio?: number
}

// canvas は CSS の変数を使えないので、描くたびに値を読む。値が無い環境 (jsdom) では
// 要素の文字色に落とす。
function cssColor(el: HTMLElement, name: string): string {
  const style = getComputedStyle(el)
  return style.getPropertyValue(name).trim() || style.color
}

/**
 * 音声の波形。再生済みは --accent、残りは --muted、中心線は --border、再生ヘッドは
 * --error (Mado Model Tracking の音声プレビューと同じ配色)。テーマを切り替えたら描き直す。
 */
export function Waveform({ peaks, progress, onSeek, height = 64, durationRatio = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useDocumentTheme()

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = height
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (peaks.length === 0 || w === 0) return

    const played = cssColor(canvas, '--accent')
    const rest = cssColor(canvas, '--muted')
    const mid = h / 2
    // 中心線は全幅に引く。トラックが短いときの右側 (0 パディング) は無音の線として見える。
    ctx.fillStyle = cssColor(canvas, '--border')
    ctx.fillRect(0, Math.floor(mid), w, 1)
    // ピークは全幅 × durationRatio の範囲に描く (残りは 0 パディングの空白)。
    const peaksW = w * Math.min(1, Math.max(0, durationRatio))
    const barW = peaksW / peaks.length
    const playedX = progress * w
    for (let i = 0; i < peaks.length; i++) {
      const [mn, mx] = peaks[i]
      const x = i * barW
      // min/max は -1〜1。高さ 1px 未満でも点として見えるように clamp。
      const top = mid - mx * mid
      const bh = Math.max(1, (mx - mn) * mid)
      ctx.fillStyle = x < playedX ? played : rest
      ctx.fillRect(x, top, Math.max(1, barW - 0.5), bh)
    }
    // 再生ヘッド線
    if (progress > 0) {
      ctx.fillStyle = cssColor(canvas, '--error')
      ctx.fillRect(playedX - 0.5, 0, 1, h)
    }
  }, [peaks, progress, height, durationRatio])

  // テーマが変わると CSS の変数の値が変わるので、theme も描き直すきっかけにする。
  useEffect(() => {
    draw()
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [draw, theme])

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onSeek(ratio)
  }, [onSeek])

  return (
    <canvas
      ref={canvasRef}
      role="slider"
      aria-label="再生位置"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={onSeek ? 0 : -1}
      className="waveform"
      style={{ height }}
      onClick={handleClick}
    />
  )
}
