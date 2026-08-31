import { describe, expect, it } from 'vitest'
import { AuthRateLimiter } from './auth-rate-limit.js'

describe('AuthRateLimiter', () => {
  it('window内の上限とresetを適用する', () => {
    const limiter = new AuthRateLimiter()
    expect(limiter.consume('ip:1', 2, 1_000, 100)).toBe(true)
    expect(limiter.consume('ip:1', 2, 1_000, 101)).toBe(true)
    expect(limiter.consume('ip:1', 2, 1_000, 102)).toBe(false)
    limiter.reset('ip:1')
    expect(limiter.consume('ip:1', 2, 1_000, 103)).toBe(true)
  })

  it('同時password検証数を制限する', async () => {
    const limiter = new AuthRateLimiter(1)
    let release!: () => void
    const first = limiter.passwordCheck(() => new Promise<void>(resolve => { release = resolve }))
    expect(await limiter.passwordCheck(async () => 'second')).toEqual({ accepted: false })
    release()
    expect(await first).toEqual({ accepted: true, value: undefined })
  })

  it('bucket数をhard capし最終利用が古いentryから退避する', () => {
    const limiter = new AuthRateLimiter(4, 2)
    expect(limiter.consume('a', 2, 1_000, 100)).toBe(true)
    expect(limiter.consume('b', 1, 1_000, 100)).toBe(true)
    expect(limiter.consume('a', 2, 1_000, 101)).toBe(true)

    // aを再利用したため、c追加時にはbがLRUとして退避される。
    expect(limiter.consume('c', 1, 1_000, 102)).toBe(true)
    expect(limiter.consume('a', 2, 1_000, 103)).toBe(false)
    expect(limiter.consume('b', 1, 1_000, 103)).toBe(true)
  })

  it('上限到達時は期限切れentryを優先して除去する', () => {
    const limiter = new AuthRateLimiter(4, 2)
    expect(limiter.consume('expired', 1, 10, 100)).toBe(true)
    expect(limiter.consume('active', 1, 1_000, 100)).toBe(true)
    expect(limiter.consume('new', 1, 1_000, 111)).toBe(true)
    expect(limiter.consume('active', 1, 1_000, 112)).toBe(false)
    expect(limiter.consume('expired', 1, 1_000, 112)).toBe(true)
  })
})
