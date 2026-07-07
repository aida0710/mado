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
