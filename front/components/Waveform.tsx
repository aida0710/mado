import { useCallback, useEffect, useRef } from 'react'

interface Props {
  peaks: Array<[number, number]>
  // 0〜1 の再生位置。再生ヘッド線 + 再生済み領域の色分けに使う。
  progress: number
  onSeek?: (ratio: number) => void
  height?: number
}

// CSS 変数を解決する。テスト (jsdom) や変数未定義時はフォールバック。
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

export function Waveform({ peaks, progress, onSeek, height = 64 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

    const played = cssVar(canvas, '--color-ink-11', '#444')
    const rest = cssVar(canvas, '--color-ink-6', '#999')
    const mid = h / 2
    const barW = w / peaks.length
    const playedX = progress * w
    for (let i = 0; i < peaks.length; i++) {
      const [mn, mx] = peaks[i]
      const x = i * barW
      // min/max は -1〜1。高さ 1px 未満でも点として見えるように clamp。
      const top = mid - mx * mid
      const bh = Math.max(1, (mx - mn) * mid)
      ctx.fillStyle = x <= playedX ? played : rest
      ctx.fillRect(x, top, Math.max(1, barW - 0.5), bh)
    }
    // 再生ヘッド線
    if (progress > 0) {
      ctx.fillStyle = played
      ctx.fillRect(playedX - 0.5, 0, 1, h)
    }
  }, [peaks, progress, height])

  useEffect(() => {
    draw()
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [draw])

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
      className="block w-full cursor-pointer"
      style={{ height }}
      onClick={handleClick}
    />
  )
}
