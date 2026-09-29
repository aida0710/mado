// 取得の状態。失敗（failed）を「値が無い」と分けて持つ。README や Team note の
// 取得失敗を「未作成」と扱うと、利用者が空のエディタから書き始めて既存の本文を
// 上書きしてしまうため。
export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'loaded'; value: T }
  | { status: 'failed'; reason: string }

// loading は毎回同じ参照を使う（消費側が依存配列に入れても再発火しないように）。
export const LOADING: LoadState<never> = { status: 'loading' }

/** 取得の失敗を、画面に出す理由付きの failed 状態にする。 */
export function failedLoad(error: unknown): LoadState<never> {
  return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
}
