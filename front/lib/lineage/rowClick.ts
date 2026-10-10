import type { MouseEvent } from 'react'

// 行の中のボタンや入力欄は自分の操作だけをする。行を押して選ぶのは、それ以外の場所を押したときだけ。
const CONTROL_SELECTOR = 'a, button, input, select, textarea, label, summary'

/** 行 (tr) のクリックが、行の中のボタンなどから来たものか。 */
export function isFromRowControl(event: MouseEvent<HTMLElement>): boolean {
  const control = (event.target as Element).closest(CONTROL_SELECTOR)
  return control !== null && event.currentTarget.contains(control)
}
