/** 再取得が先に完了しても、遅れて届いた初期キャッシュで表示を戻さない。
 *  各ロードごとに作り、表示中の内容と取得時刻を同じ応答から受け取る。 */
export function createRevalidationReceiver<Value>(receive: (value: Value) => void) {
  let hasRevalidated = false
  return {
    receiveInitial(value: Value): void {
      if (!hasRevalidated) receive(value)
    },
    receiveRevalidated(value: Value): void {
      hasRevalidated = true
      receive(value)
    },
  }
}
