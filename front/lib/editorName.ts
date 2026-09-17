// 署名名 (README / ノートの編集者として記録される名前)。
//
// この端末だけの設定で、サーバーには保存しない。mado は認証を持たないので
// 「誰が書いたか」は自己申告であり、端末ごとに 1 つ持てば足りる。
//
// キー名 'dashboard.lastEditor' は役割 (Settings で明示的に設定する署名名) と
// 合っていないが、変えると各端末の localStorage に入っている値が消えるので据え置く。
export const EDITOR_NAME_KEY = 'dashboard.lastEditor'

export function getEditorName(): string {
  try {
    return localStorage.getItem(EDITOR_NAME_KEY) ?? ''
  } catch {
    // localStorage が使えない環境 (プライベートモード等) でも編集は続けられる。
    return ''
  }
}

export function setEditorName(name: string): void {
  try {
    const trimmed = name.trim()
    if (trimmed === '') localStorage.removeItem(EDITOR_NAME_KEY)
    else localStorage.setItem(EDITOR_NAME_KEY, trimmed)
  } catch {
    /* 保存できなくても致命的ではない */
  }
}
