import { describe, expect, it } from 'vitest'
import {
  computeDrawerVars,
  DRAWER_MAX_DEFAULT_W,
  DRAWER_MIN_W,
  DRAWER_MIN_LIST_VISIBLE,
} from './useDrawerResize'

describe('computeDrawerVars - responsive default (effW = null)', () => {
  it('scales the default width with container width', () => {
    // 28% of 1280 = 358.4 → 358
    expect(computeDrawerVars(1280, null).width).toBe(358)
    // 28% of 1920 = 537.6 → 538
    expect(computeDrawerVars(1920, null).width).toBe(538)
  })

  it('clamps the default to the max on very wide screens', () => {
    expect(computeDrawerVars(4000, null).width).toBe(DRAWER_MAX_DEFAULT_W)
  })

  it('clamps the default to the min on narrow 2-col screens', () => {
    // 28% of 1000 = 280 → floored to MIN_W
    expect(computeDrawerVars(1000, null).width).toBe(DRAWER_MIN_W)
  })

  it('never overlays at the default (marginLeft 0, track === width)', () => {
    const v = computeDrawerVars(1600, null)
    expect(v.marginLeft).toBe(0)
    expect(v.track).toBe(v.width)
  })
})

describe('computeDrawerVars - widening overlays without compressing the list', () => {
  it('keeps the track at base and pulls the drawer left (negative margin)', () => {
    const { base } = computeDrawerVars(1280, null) // 358
    const v = computeDrawerVars(1280, base + 300) // 658
    expect(v.track).toBe(base) // リスト幅 (= 1fr) は既定のまま据え置き
    expect(v.width).toBe(base + 300)
    expect(v.marginLeft).toBe(base - (base + 300)) // = -300 (overlay)
  })

  it('clamps widening so the list keeps a minimum visible strip', () => {
    const v = computeDrawerVars(1280, 5000)
    expect(v.width).toBe(1280 - DRAWER_MIN_LIST_VISIBLE) // 1060
    expect(v.maxW).toBe(1280 - DRAWER_MIN_LIST_VISIBLE)
  })
})

describe('computeDrawerVars - narrowing widens the list (no gap, no overlay)', () => {
  it('shrinks the track with the drawer when narrower than base', () => {
    const { base } = computeDrawerVars(1600, null)
    const narrow = base - 80
    const v = computeDrawerVars(1600, narrow)
    expect(v.width).toBe(narrow)
    expect(v.track).toBe(narrow) // track も縮む → リストが広がる
    expect(v.marginLeft).toBe(0) // 隙間も重なりも無し
  })

  it('clamps narrowing to the min width', () => {
    expect(computeDrawerVars(1600, 50).width).toBe(DRAWER_MIN_W)
  })
})
