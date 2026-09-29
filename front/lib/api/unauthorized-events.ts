// API が 401 を返したこと（session が無い、または切れたこと）を、認証状態を持つ
// AuthGate へ知らせる。API の呼び出しは画面のあちこちにあるので、各画面で 401 を
// 見分けるのではなく、http.ts の 1 か所から知らせる。

type UnauthorizedListener = () => void

const listeners = new Set<UnauthorizedListener>()

/** API が 401 を返したことを、購読しているところすべてへ知らせる。 */
export function notifyUnauthorized(): void {
  for (const listener of [...listeners]) listener()
}

/** 401 の知らせを受け取る。戻り値を呼ぶと購読をやめる。 */
export function subscribeUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
