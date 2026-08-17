// 署名名 (README / ノートの編集者として記録される名前)。
//
// この端末だけの設定で、サーバーには保存しない。mado は認証を持たないので
// 「誰が書いたか」は自己申告であり、端末ごとに 1 つ持てば足りる。
//
// キーは既存の 'dashboard.lastEditor' を据え置く。以前は保存のたびに
// 上書きされる「最後に使った名前」だったが、Settings から明示的に設定する
// 「自分の署名名」に役割を変えた。すでに入っている値をそのまま引き継ぐため
// キー名は変えない。
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
