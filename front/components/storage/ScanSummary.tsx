// 一覧のキャッシュバナー右端に出す、配下の集計の要約。
//
// もとは Σ ボタンだったが、押すまで何も分からなかった。4 分かけて数えた
// 結果がボタンの向こうに隠れているのはもったいないので、走査済みなら
// 数字をその場に出す。未走査のときだけ誘い文句になる。

import { fmtSize } from '../../lib/format'
import type { ScanResult } from '../../lib/api/types'

interface Props {
  /** 最後に成功した走査の結果。null = まだ走査していない。 */
  result: ScanResult | null
  /** 実行中の走査があるか。リロードしても worker 側で走り続けるので、
   *  ここで拾って「走査中」を出す。 */
  running?: boolean
  /** 内訳モーダルを開く。 */
  onOpen: () => void
}

export function ScanSummary({ result, running, onOpen }: Props) {
  // 走査中は前回の結果より現在の状態を優先して伝える。
  if (running) {
    return (
      <button type="button" className="cache-banner__scan-cta" onClick={onOpen}>
        配下を走査中…
      </button>
    )
  }

  if (!result) {
    return (
      <button type="button" className="cache-banner__scan-cta" onClick={onOpen}>
        配下を集計する
      </button>
    )
  }

  return (
    <span className="cache-banner__scan">
      配下{' '}
      <strong className="cache-banner__at">{result.objectCount.toLocaleString()}</strong> 件 /{' '}
      <strong className="cache-banner__at">{fmtSize(result.totalBytes)}</strong>
      {result.partial && (
        <span
          className="cache-banner__partial"
          title="走査中にエラーが出たため、集計は途中までです"
          aria-label="集計は途中まで"
        >
          *
        </span>
      )}
      <button type="button" className="cache-banner__scan-cta" onClick={onOpen}>内訳</button>
    </span>
  )
}
