// 同期デッキのドリフト補正。<audio> を複数同時 play() してもクロックは
// 徐々にずれるので、1 秒ごとにマスター時刻へ引き戻す対象を計算する。
// サンプル精度ではない (数十 ms) — チャンネル聴き比べ用途には十分。
export function computeDriftAdjustments(
  masterSec: number,
  trackSecs: Array<number | null>,
  thresholdSec = 0.05,
): Array<{ index: number; to: number }> {
  const out: Array<{ index: number; to: number }> = []
  trackSecs.forEach((t, index) => {
    if (t == null) return
    if (Math.abs(t - masterSec) >= thresholdSec) out.push({ index, to: masterSec })
  })
  return out
}

// 非終了トラックの currentTime の最大値をマスター時刻とする。終了 (ended) は
// null で渡し無視する。全 null (全トラック終了) なら null を返す。
// マスターを「先頭トラック」ではなく「まだ鳴っている中の最長 (最も進んだ) 時刻」に
// することで、短いトラックが終わっても時計が止まらず、長いトラックを終端へ
// 巻き戻さない (= 短いトラックの終端以降は無音 = 0 パディング)。
export function masterTimeOf(trackSecs: Array<number | null>): number | null {
  let max: number | null = null
  for (const t of trackSecs) {
    if (t == null) continue
    if (max == null || t > max) max = t
  }
  return max
}
