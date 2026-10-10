import type { MouseEvent } from 'react'

// 行 (tr) を押して開く・選ぶ一覧に共通の判定。行の中のボタンや入力欄は自分の操作だけをし、
// 行を押したことにするのは、それ以外の場所を押したときだけにする。

const CONTROL_SELECTOR = 'a, button, input, select, textarea, label, summary'

/** 行 (tr) のクリックが、行の中のボタンなどから来たものか。 */
export function isFromRowControl(event: MouseEvent<HTMLElement>): boolean {
  const control = (event.target as Element).closest(CONTROL_SELECTOR)
  return control !== null && event.currentTarget.contains(control)
}

/** 行の中の文字をドラッグで選び終えたところか。名前をコピーしようとしただけで開かないようにする。 */
function isSelectingRowText(event: MouseEvent<HTMLElement>): boolean {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed
    && selection.anchorNode !== null && event.currentTarget.contains(selection.anchorNode)
}

/** 行を押して開く・選ぶ操作として扱ってよいクリックか。 */
export function isRowActivation(event: MouseEvent<HTMLElement>): boolean {
  return !isFromRowControl(event) && !isSelectingRowText(event)
}
