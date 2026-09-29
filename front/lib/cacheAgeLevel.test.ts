import { describe, expect, it } from 'vitest'
import { cacheAgeLevel } from './cacheAgeLevel'

const NOW = new Date('2026-09-29T12:00:00+09:00')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)

describe('cacheAgeLevel', () => {
  it.each([
    [0, 'within-1h'],
    [0.99, 'within-1h'],
    [1, 'within-3h'],
    [2.99, 'within-3h'],
    [3, 'within-6h'],
    [6, 'within-12h'],
    [12, 'within-24h'],
    [23.99, 'within-24h'],
    [24, 'over-24h'],
    [24 * 30, 'over-24h'],
  ])('取得から%s時間経つと %s になる', (hours, level) => {
    expect(cacheAgeLevel(hoursAgo(hours), NOW).level).toBe(level)
  })

  it('取得時刻が現在より後でもいちばん新しい段階にする', () => {
    expect(cacheAgeLevel(hoursAgo(-2), NOW).level).toBe('within-1h')
  })

  it('段階の説明に経過時間の範囲を入れる', () => {
    expect(cacheAgeLevel(hoursAgo(7), NOW).label).toBe('取得から6〜12時間')
  })
})
