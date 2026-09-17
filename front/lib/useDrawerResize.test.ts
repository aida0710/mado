import { describe, expect, it } from 'vitest'
import {
  computeDrawerVars,
  DRAWER_MAX_DEFAULT_W,
  DRAWER_MIN_W,
  DRAWER_MIN_LIST_VISIBLE,
} from './useDrawerResize'

describe('computeDrawerVars - 画面幅に応じた既定 (effW = null)', () => {
  it('既定幅はコンテナ幅に比例する', () => {
    // 36% of 1280 = 460.8 → 461
    expect(computeDrawerVars(1280, null).width).toBe(461)
    // 36% of 1920 = 691.2 → 691
    expect(computeDrawerVars(1920, null).width).toBe(691)
  })

  it('とても広い画面では既定幅を上限で止める', () => {
    expect(computeDrawerVars(4000, null).width).toBe(DRAWER_MAX_DEFAULT_W)
  })

  it('狭い 2 カラム画面では既定幅を下限で止める', () => {
    // 36% of 800 = 288 → floored to MIN_W
    expect(computeDrawerVars(800, null).width).toBe(DRAWER_MIN_W)
  })

  it('既定幅では一覧に重ならない (marginLeft 0、track が幅と同じ)', () => {
    const v = computeDrawerVars(1600, null)
    expect(v.marginLeft).toBe(0)
    expect(v.track).toBe(v.width)
  })
})

describe('computeDrawerVars - 広げると一覧を縮めずに重なる', () => {
  it('広げると track は基準幅のまま、ドロワーが左に張り出す (負の margin)', () => {
    const { base } = computeDrawerVars(1280, null) // 358
    const v = computeDrawerVars(1280, base + 300) // 658
    expect(v.track).toBe(base) // リスト幅 (= 1fr) は既定のまま据え置き
    expect(v.width).toBe(base + 300)
    expect(v.marginLeft).toBe(base - (base + 300)) // = -300 (overlay)
  })

  it('一覧の最小幅が残るところで広げるのを止める', () => {
    const v = computeDrawerVars(1280, 5000)
    expect(v.width).toBe(1280 - DRAWER_MIN_LIST_VISIBLE) // 1060
    expect(v.maxW).toBe(1280 - DRAWER_MIN_LIST_VISIBLE)
  })
})

describe('computeDrawerVars - 狭めると一覧が広がる (隙間も重なりも無い)', () => {
  it('基準幅より狭めると track も一緒に縮む', () => {
    const { base } = computeDrawerVars(1600, null)
    const narrow = base - 80
    const v = computeDrawerVars(1600, narrow)
    expect(v.width).toBe(narrow)
    expect(v.track).toBe(narrow) // track も縮む → リストが広がる
    expect(v.marginLeft).toBe(0) // 隙間も重なりも無し
  })

  it('狭めるのは最小幅で止める', () => {
    expect(computeDrawerVars(1600, 50).width).toBe(DRAWER_MIN_W)
  })
})
