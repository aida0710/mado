interface Bucket {
  count: number
  resetAt: number
}

export class AuthRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private activePasswordChecks = 0

  constructor(
    private readonly maxConcurrentPasswordChecks = 4,
    private readonly maxBuckets = 2_000,
  ) {
    if (maxBuckets < 1) throw new Error('maxBuckets must be at least 1')
  }

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.buckets.get(key)
    if (!current || current.resetAt <= now) {
      if (current) this.buckets.delete(key)
      this.ensureCapacity(now)
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    // Mapの挿入順を最終利用順として使い、上限到達時にLRUを退避する。
    this.buckets.delete(key)
    this.buckets.set(key, current)
    if (current.count >= limit) return false
    current.count += 1
    return true
  }

  reset(...keys: string[]): void {
    for (const key of keys) this.buckets.delete(key)
  }

  async passwordCheck<T>(task: () => Promise<T>): Promise<{ accepted: true; value: T } | { accepted: false }> {
    if (this.activePasswordChecks >= this.maxConcurrentPasswordChecks) return { accepted: false }
    this.activePasswordChecks += 1
    try {
      return { accepted: true, value: await task() }
    } finally {
      this.activePasswordChecks -= 1
    }
  }

  private ensureCapacity(now: number): void {
    if (this.buckets.size < this.maxBuckets) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next().value
      if (oldest === undefined) break
      this.buckets.delete(oldest)
    }
  }
}
