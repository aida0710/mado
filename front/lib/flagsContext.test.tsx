import { describe, expect, it } from 'vitest'
import { isEnabled, isEnabledStrict } from './flagsContext'

describe('isEnabled (fail-open)', () => {
  it('null は true (loading 中はチラつかせず表示)', () => {
    expect(isEnabled(null, 'x')).toBe(true)
  })
  it('未定義フラグは true', () => {
    expect(isEnabled({}, 'x')).toBe(true)
  })
  it('明示的に false のときだけ false', () => {
    expect(isEnabled({ x: false }, 'x')).toBe(false)
  })
  it('true は true', () => {
    expect(isEnabled({ x: true }, 'x')).toBe(true)
  })
})

describe('isEnabledStrict (fail-closed)', () => {
  it('null は false', () => {
    expect(isEnabledStrict(null, 'x')).toBe(false)
  })
  it('未定義フラグは false', () => {
    expect(isEnabledStrict({}, 'x')).toBe(false)
  })
  it('false は false', () => {
    expect(isEnabledStrict({ x: false }, 'x')).toBe(false)
  })
  it('true のみ true', () => {
    expect(isEnabledStrict({ x: true }, 'x')).toBe(true)
  })
})
