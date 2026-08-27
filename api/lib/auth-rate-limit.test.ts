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
})
