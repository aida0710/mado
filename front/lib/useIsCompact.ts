import { narrowerThan } from './breakpoints'
import { useMediaQuery } from './useMediaQuery'

/**
 * 640px 未満 (スマホ) なら true。一覧の表の列を減らすのに使う。
 * CSS の display:none で列を隠すと jsdom + Testing Library では隠した側の文字も見つかって
 * 紛らわしいので、幅を購読してどちらか一方だけを描く。サーバー描画では広い画面の形にする。
 */
export function useIsCompact(): boolean {
  return useMediaQuery(narrowerThan('sm'))
}
