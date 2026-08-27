interface Bucket {
  count: number
  resetAt: number
}

export class AuthRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private activePasswordChecks = 0

  constructor(private readonly maxConcurrentPasswordChecks = 4) {}

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.buckets.get(key)
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      this.prune(now)
      return true
    }
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

  private prune(now: number): void {
    if (this.buckets.size < 2_000) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}
