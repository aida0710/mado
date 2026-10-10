import { describe, expect, it } from 'vitest'
import { clampNavigationWidth, NAVIGATION_WIDTH, storedNavigationWidth } from './navigationWidth'

describe('navigation width', () => {
  it('ドラッグした幅を下限と上限の間に収め、整数にする', () => {
    expect(clampNavigationWidth(100)).toBe(NAVIGATION_WIDTH.min)
    expect(clampNavigationWidth(900)).toBe(NAVIGATION_WIDTH.max)
    expect(clampNavigationWidth(250.6)).toBe(251)
  })

  it('保存した幅が無いか読めないときは既定の幅にする', () => {
    expect(storedNavigationWidth(null)).toBe(NAVIGATION_WIDTH.default)
    expect(storedNavigationWidth('wide')).toBe(NAVIGATION_WIDTH.default)
    expect(storedNavigationWidth('240')).toBe(240)
    expect(storedNavigationWidth('9999')).toBe(NAVIGATION_WIDTH.max)
  })
})
