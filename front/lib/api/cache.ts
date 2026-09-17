// シンプルな TTL 付きインメモリキャッシュ + 同一キーの in-flight リクエスト dedup
// + 任意で localStorage への永続化。
//
// 設計の動機:
//  - S3 ディレクトリを行き来したときに list / readme を毎回再取得していて遅い。
//  - 編集後 (putReadme) は即時に最新化したいので、ミューテーション側から
//    invalidate を呼べる API が必要。
//  - 同じキーで複数の呼び出しが並行して走ったときは、ネットワークコールを
//    1 回に集約 (in-flight dedup)。
//  - ブラウザリロード越しでも 上流への重い fetch (7〜24 秒) を繰り返したくない。
//    persistKey を渡したインスタンスは値を localStorage にも書き出し、TTL 内なら
//    リロード後の初回 get で hydrate する。
//  - TTL 切れのたびに数十秒待たされるのが辛い。onRevalidate を渡した呼び出しは
//    stale-while-revalidate になり、期限切れの値を即返しつつ裏で loader を回す
//    (S3 のディレクトリ/オブジェクトは増えることはあっても消えにくいので、
//     一瞬古い一覧を見せる不利益より待たされない利益の方が大きい)。
//    コールバックを渡さない呼び出しは従来どおり blocking のままなので、
//    UI 側で更新を受け取る配線をしていない画面が古いまま固まることはない。

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

export interface TTLCacheOptions<V = unknown> {
  /**
   * 指定すると localStorage に値を書き出す。namespace 兼識別子で、
   * 実際の storage key は `${persistKey}:${cacheKey}` になる。
   * (未指定なら従来通り in-memory のみ — テストや短 TTL 用)
   */
  persistKey?: string
  /** Value supplied by the server may have an earlier authoritative expiry.
   *  The local cache never lives beyond either this timestamp or ttlMs. */
  expiresAt?: (value: V) => number | null
}

export class TTLCache<V> {
  private readonly store = new Map<string, Entry<V>>()
  private readonly ttlMs: number
  private readonly persistKey: string | null
  private readonly valueExpiresAt: ((value: V) => number | null) | null

  constructor(ttlMs: number, opts: TTLCacheOptions<V> = {}) {
    this.ttlMs = ttlMs
    this.persistKey = opts.persistKey ?? null
    this.valueExpiresAt = opts.expiresAt ?? null
  }

  /**
   * TTL 内の値があれば即返す。無ければ localStorage から hydrate、それも無ければ
   * loader() を呼ぶ。in-flight があれば相乗りする。
   * loader が reject したらエントリを削除する (= 次回再試行)。
   *
   * onRevalidate を渡すと stale-while-revalidate になる: 期限切れの値があるときは
   * それを即返し、裏で走らせた fetch の Promise を (get が返る前に同期的に)
   * コールバックへ渡す。呼び出し側はそれを await して新しい値で描き直す。
   * 期限切れの値が無いときや、そもそもコールバックを渡さないときの挙動は従来通り。
   */
  async get(
    key: string,
    loader: () => Promise<V>,
    onRevalidate?: (fresh: Promise<V>) => void,
  ): Promise<V> {
    const now = Date.now()
    let entry = this.store.get(key)
    if (entry?.value !== undefined && now < entry.expiresAt) return entry.value

    // in-memory に無ければ localStorage を確認して hydrate。
    // 期限切れでも捨てずに拾う — SWR の stale 供給元になる。
    if (!entry) {
      const persisted = this.readPersisted(key)
      if (persisted) {
        entry = { value: persisted.value, expiresAt: persisted.expiresAt }
        this.store.set(key, entry)
        if (now < entry.expiresAt) return persisted.value
      }
    }

    // ここに来るのは「値が無い」か「値はあるが期限切れ」。
    if (entry?.value !== undefined && onRevalidate) {
      // 進行中の revalidate があれば相乗り、無ければ起動する。
      onRevalidate(entry.promise ?? this.startRevalidate(key, entry, loader))
      return entry.value
    }
    if (entry?.promise) return entry.promise

    // blocking fetch。値が確定するまで value を持たない (getFetchedAt は null)。
    const promise = loader()
    const pending: Entry<V> = { promise, expiresAt: now + this.ttlMs }
    this.store.set(key, pending)
    try {
      const value = await promise
      // 待っている間に invalidate されていたら書き戻さない。
      // 呼び出し元には返すが、キャッシュには残さない (次の get は再取得する)。
      if (this.store.get(key) === pending) this.commit(key, value)
      return value
    } catch (e) {
      if (this.store.get(key) === pending) this.store.delete(key)
      throw e
    }
  }

  /**
   * 裏側の再取得を開始する。stale な value / expiresAt は据え置き
   * (= 表示中の「取得 HH:mm」が更新完了まで古い時刻のままになる)。
   * 失敗したら promise だけ外して stale を残す — 次の get で再試行される。
   */
  private startRevalidate(key: string, entry: Entry<V>, loader: () => Promise<V>): Promise<V> {
    const promise = loader()
    entry.promise = promise
    promise.then(
      value => {
        // 走っている間に invalidate されていたら着弾を捨てる。書き戻すと
        // アップロード/削除で消したはずの古い一覧が復活してしまう。
        if (this.store.get(key) === entry) this.commit(key, value)
      },
      () => {
        if (this.store.get(key) === entry) entry.promise = undefined
      },
    )
    return promise
  }

  /** 確定した値でエントリを差し替え、永続層にも書き出す。 */
  private commit(key: string, value: V): void {
    const localExpiresAt = Date.now() + this.ttlMs
    const authoritativeExpiresAt = this.valueExpiresAt?.(value) ?? null
    const expiresAt = authoritativeExpiresAt != null && Number.isFinite(authoritativeExpiresAt)
      ? Math.min(localExpiresAt, authoritativeExpiresAt)
      : localExpiresAt
    this.store.set(key, { value, expiresAt })
    this.writePersisted(key, value, expiresAt)
  }

  /** 現在保持している値を、期限切れを含めて返す。表示中のstale値がいつ
   *  upstreamから取得されたかを値自身のmetadataから読む用途。 */
  peek(key: string): V | null {
    const cur = this.store.get(key)
    if (cur?.value !== undefined) return cur.value
    return this.readPersisted(key)?.value ?? null
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
      // 期限切れでもそのまま返す。捨てるかどうかは get 側の判断
      // (SWR ならリロード直後の初期表示に使い、そうでなければ blocking fetch で上書き)。
      return JSON.parse(raw) as PersistedEntry<V>
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

// セッション内 (タブを開いている間) のレスポンスキャッシュの TTL。
// S3 ディレクトリの行き来や preview の開閉で毎回 fetch が走るのを抑える。
//
// 短 TTL (5 分) — in-memory のみ、永続化しない:
//   favorites: DB 由来で他端末からの toggle が概ね 5 分以内に見える。
//   tar:       一度プレビューすれば次は別アーカイブを見るユースケースが多く、
//              localStorage に貯める価値が薄い (容量も大きい)。in-flight dedup と
//              ページャ内の前後ボタン用にのみ in-memory cache を残す。
// 長 TTL (6 時間) — localStorage 永続化:
//   list / readme / buckets: 上流のレイテンシが 7〜24 秒と高く、ディレクトリ階層や
//              README の増減は緩いのでリロード越しのキャッシュ効果が大きい。
//   UI で「取得 HH:mm」を薄く表示してキャッシュ鮮度を可視化 (api.lastFetched.*)。
//   TTL 切れ後は onRevalidate 付きで呼ぶことで stale-while-revalidate になる
//   (古い一覧を即表示 →「更新中…」→ 到着したら差し替え)。
//   変更時は対応する invalidateXxx() を明示的に呼んで破棄する設計
//   (アップロード/削除/編集等のミューテーション + UI の 🔄 refresh ボタン)。
export const SHORT_CACHE_TTL_MS = 5 * 60 * 1000
export const LONG_CACHE_TTL_MS = 6 * 60 * 60 * 1000
