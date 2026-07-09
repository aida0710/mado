// プレビューできないファイルの案内。ドロワー / ピンカード / tar エントリモーダルの
// 3 箇所で同じ文言を出すため共有する。
export function UnsupportedPreview() {
  return (
    <p className="text-[13px] text-ink-7">
      プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
    </p>
  )
}
