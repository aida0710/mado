// プレビューの中身がテキストかバイナリかを、拡張子ではなく先頭バイトで判定する。
//
// 判定は NUL バイトの有無だけ。UTF-8 として妥当かまでは見ない — 見てしまうと、
// いま文字化けしつつも表示できている Shift_JIS の .txt が「非対応」に変わり
// 退行する。逆に 64 KB の中に NUL が 1 つも無いバイナリは実質存在しないので、
// この 1 点で npy / wav / 画像 / 圧縮形式はすべて弾ける。

// サーバーが返すテキストプレビューの上限と同値 (api/env.ts の PREVIEW_TEXT_LIMIT)。
// 片方を変えたら他方も変えること。
export const TEXT_HEAD_BYTES = 65536

export function looksBinary(head: Uint8Array): boolean {
  return head.includes(0)
}
