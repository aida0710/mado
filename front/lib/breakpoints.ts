// 画面幅の切り替え点。Mado Model Tracking と同じ 3 つ (@mado/design-tokens の CSS も同じ値)。
// CSS のメディアクエリは同じ値を範囲の書き方 (`@media (width < 900px)`) で書き、
// Tailwind の sm / md / lg も App.css の @theme でこの値に合わせている。
export const BREAKPOINT_PX = {
  sm: 640,
  md: 900,
  lg: 1200,
} as const

export type Breakpoint = keyof typeof BREAKPOINT_PX

/** 画面幅が `breakpoint` より狭い間だけ一致するメディアクエリ。 */
export function narrowerThan(breakpoint: Breakpoint): string {
  return `(width < ${BREAKPOINT_PX[breakpoint]}px)`
}
