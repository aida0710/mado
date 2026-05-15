// シンプルな TTL 付きインメモリキャッシュ + 同一キーの in-flight リクエスト dedup
// + 任意で localStorage への永続化。
//
// 設計の動機:
//  - S3 ディレクトリを行き来したときに list / readme を毎回再取得していて遅い。
//  - 編集後 (putReadme) は即時に最新化したいので、ミューテーション側から
//    invalidate を呼べる API が必要。
//  - 同じキーで複数の呼び出しが並行して走ったときは、ネットワークコールを
//    1 回に集約 (in-flight dedup)。
//  - ブラウザリロード越しでも MDX への重い fetch (7〜24 秒) を繰り返したくない。
//    persistKey を渡したインスタンスは値を localStorage にも書き出し、TTL 内なら
//    リロード後の初回 get で hydrate する。

interface Entry<V> {
  // キャッシュ済みの値 (両方が undefined なのは初期化エラーで delete 済みのケース)。
  value?: V
  // 進行中の fetch。並行呼び出しはこれを await する。
  promise?: Promise<V>
  // 値が確定したタイムスタンプ (= TTL 起算点)。
  expiresAt: number
}

interface PersistedEntry<V> {
  value: V
  expiresAt: number
}

export interface TTLCacheOptions {
  /**
   * 指定すると localStorage に値を書き出す。namespace 兼識別子で、
   * 実際の storage key は `${persistKey}:${cacheKey}` になる。
   * (未指定なら従来通り in-memory のみ — テストや短 TTL 用)
   */
  persistKey?: string
}

export class TTLCache<V> {
  private readonly store = new Map<string, Entry<V>>()
  private readonly ttlMs: number
  private readonly persistKey: string | null

  constructor(ttlMs: number, opts: TTLCacheOptions = {}) {
    this.ttlMs = ttlMs
    this.persistKey = opts.persistKey ?? null
  }

  /**
   * キャッシュにヒットすれば即返す。in-flight があれば待つ。
   * どちらも無ければ localStorage を確認、それでも無ければ loader() を呼ぶ。
   * loader が reject したらエントリを削除する (= 次回再試行)。
   */
  async get(key: string, loader: () => Promise<V>): Promise<V> {
    const now = Date.now()
    const cur = this.store.get(key)
    if (cur) {
      if (cur.promise) return cur.promise
      if (cur.value !== undefined && now < cur.expiresAt) return cur.value
    }
    // in-memory に無ければ localStorage を確認して hydrate
    const persisted = this.readPersisted(key)
    if (persisted && now < persisted.expiresAt) {
      this.store.set(key, { value: persisted.value, expiresAt: persisted.expiresAt })
      return persisted.value
    }
    // どこにも無いので fetch
    const promise = loader()
    this.store.set(key, { promise, expiresAt: now + this.ttlMs })
    try {
      const value = await promise
      const entry: Entry<V> = { value, expiresAt: Date.now() + this.ttlMs }
      this.store.set(key, entry)
      this.writePersisted(key, value, entry.expiresAt)
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
    if (cur && cur.value !== undefined) return cur.expiresAt - this.ttlMs
    // in-memory miss でも persist が生きていれば時刻だけは取れる
    const persisted = this.readPersisted(key)
    if (persisted) return persisted.expiresAt - this.ttlMs
    return null
  }

  /** 1 キーを破棄 (次回 get で fetch される)。 */
  invalidate(key: string): void {
    this.store.delete(key)
    this.deletePersisted(key)
  }

  /** キーが特定の prefix で始まるエントリをすべて破棄。 */
  invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k)
    }
    if (this.persistKey && typeof localStorage !== 'undefined') {
      const storagePrefix = `${this.persistKey}:${prefix}`
      try {
        const victims: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith(storagePrefix)) victims.push(k)
        }
        for (const k of victims) localStorage.removeItem(k)
      } catch { /* localStorage 不可 — silent */ }
    }
  }

  clear(): void {
    this.store.clear()
    if (this.persistKey && typeof localStorage !== 'undefined') {
      const storagePrefix = `${this.persistKey}:`
      try {
        const victims: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith(storagePrefix)) victims.push(k)
        }
        for (const k of victims) localStorage.removeItem(k)
      } catch { /* silent */ }
    }
  }

  // ─── localStorage 永続化 ──────────────────────────────────────────
  // 失敗は常に silent (quota exceeded / privacy mode / JSON parse 失敗等)
  // 永続化が失われても in-memory cache は機能し続ける。

  private storageKeyFor(key: string): string | null {
    return this.persistKey ? `${this.persistKey}:${key}` : null
  }

  private readPersisted(key: string): PersistedEntry<V> | null {
    const sk = this.storageKeyFor(key)
    if (!sk || typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(sk)
      if (!raw) return null
      const parsed = JSON.parse(raw) as PersistedEntry<V>
      // 期限切れは即削除して null 返却 (次回 get で fresh fetch)
      if (Date.now() >= parsed.expiresAt) {
        localStorage.removeItem(sk)
        return null
      }
      return parsed
    } catch {
      // 壊れたエントリは破棄
      try { localStorage.removeItem(sk) } catch { /* ignore */ }
      return null
    }
  }

  private writePersisted(key: string, value: V, expiresAt: number): void {
    const sk = this.storageKeyFor(key)
    if (!sk || typeof localStorage === 'undefined') return
    try {
      const payload: PersistedEntry<V> = { value, expiresAt }
      localStorage.setItem(sk, JSON.stringify(payload))
    } catch {
      // quota exceeded など — in-memory のみで運用継続
    }
  }

  private deletePersisted(key: string): void {
    const sk = this.storageKeyFor(key)
    if (!sk || typeof localStorage === 'undefined') return
    try { localStorage.removeItem(sk) } catch { /* silent */ }
  }

  // 単体テストから内部状態を覗くため。本番コードでは使わない。
  _size(): number { return this.store.size }
}
