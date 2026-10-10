// 左のサイドバーの幅 (px)。ドラッグと矢印キーで min〜max の間を変えられる。
// Mado Model Tracking と同じ値。
export const NAVIGATION_WIDTH = { default: 192, min: 160, max: 360, keyboardStep: 16 } as const

export function clampNavigationWidth(width: number): number {
  return Math.round(Math.min(NAVIGATION_WIDTH.max, Math.max(NAVIGATION_WIDTH.min, width)))
}

/** localStorage に残した幅。読めない値なら既定の幅。 */
export function storedNavigationWidth(raw: string | null): number {
  const width = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(width) ? clampNavigationWidth(width) : NAVIGATION_WIDTH.default
}
