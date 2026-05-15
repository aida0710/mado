// シンプルな TTL 付きインメモリキャッシュ + 同一キーの in-flight リクエスト dedup。
//
// 設計の動機:
//  - S3 ディレクトリを行き来したときに list / readme を毎回再取得していて遅い。
//  - 編集後 (putReadme) は即時に最新化したいので、ミューテーション側から
//    invalidate を呼べる API が必要。
//  - 同じキーで複数の呼び出しが並行して走ったときは、ネットワークコールを
//    1 回に集約 (in-flight dedup)。

interface Entry<V> {
  // キャッシュ済みの値 (両方が undefined なのは初期化エラーで delete 済みのケース)。
  value?: V
  // 進行中の fetch。並行呼び出しはこれを await する。
  promise?: Promise<V>
  // 値が確定したタイムスタンプ (= TTL 起算点)。
  expiresAt: number
}

export class TTLCache<V> {
  private readonly store = new Map<string, Entry<V>>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  /**
   * キャッシュにヒットすれば即返す。in-flight があれば待つ。
   * どちらも無ければ loader() を呼んで結果を保持する。
   * loader が reject したらエントリを削除する (= 次回再試行)。
   */
  async get(key: string, loader: () => Promise<V>): Promise<V> {
    const now = Date.now()
    const cur = this.store.get(key)
    if (cur) {
      if (cur.promise) return cur.promise
      if (cur.value !== undefined && now < cur.expiresAt) return cur.value
    }
    const promise = loader()
    this.store.set(key, { promise, expiresAt: now + this.ttlMs })
    try {
      const value = await promise
      this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
      return value
    } catch (e) {
      this.store.delete(key)
      throw e
    }
  }

  /** 該当キーの「値が確定したタイムスタンプ」(epoch ms)。値が無いか
   *  まだ in-flight (promise だけ) なら null を返す。`expiresAt - ttlMs` を
   *  逆算するので追加のメモリは不要。UI で「いつのキャッシュか」を出すのに使う。 */
  getFetchedAt(key: string): number | null {
    const cur = this.store.get(key)
    if (!cur || cur.value === undefined) return null
    return cur.expiresAt - this.ttlMs
  }

  /** 1 キーを破棄 (次回 get で fetch される)。 */
  invalidate(key: string): void {
    this.store.delete(key)
  }

  /** キーが特定の prefix で始まるエントリをすべて破棄。 */
  invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k)
    }
  }

  clear(): void {
    this.store.clear()
  }

  // 単体テストから内部状態を覗くため。本番コードでは使わない。
  _size(): number { return this.store.size }
}
