import { describe, expect, it } from 'vitest'
import { parseByteRange } from './byte-range.js'

describe('動画の部分取得範囲', () => {
  it('開始と終了が指定されたら、その区間になる', () => {
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
  })

  it('終了を省略するとファイルの末尾までになる', () => {
    expect(parseByteRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
  })

  it('末尾のバイト数を指定すると最後の区間になる', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('終了がファイルを超えていたら、末尾で止まる', () => {
    expect(parseByteRange('bytes=900-2000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange('bytes=-2000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it.each(['bytes=1000-', 'bytes=200-100', 'bytes=-0', 'bytes=-', 'bytes=a-b', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9007199254740992-'])('不正・範囲外の指定%sは取得できない', header => {
    expect(parseByteRange(header, 1000)).toBeNull()
  })

  it('空ファイルへの範囲指定は取得できない', () => {
    expect(parseByteRange('bytes=0-', 0)).toBeNull()
  })
})
