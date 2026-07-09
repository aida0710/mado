import { describe, expect, it } from 'vitest'
import { looksBinary, TEXT_HEAD_BYTES } from './textSniff'

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('looksBinary', () => {
  it('空バイト列はテキスト扱い', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false)
  })

  it('ASCII / 日本語 UTF-8 はテキスト', () => {
    expect(looksBinary(utf8('hello\nworld\t!'))).toBe(false)
    expect(looksBinary(utf8('こんにちは 世界'))).toBe(false)
  })

  it('npy のヘッダは NUL を含むのでバイナリ', () => {
    // \x93NUMPY + version major=1 minor=0 → 末尾に NUL が必ず来る
    expect(looksBinary(bytes(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00))).toBe(true)
  })

  it('WAV のヘッダも NUL を含むのでバイナリ', () => {
    // "RIFF" + size + "WAVE" — size フィールドに NUL が入る
    expect(looksBinary(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00))).toBe(true)
  })

  it('Shift_JIS のバイト列は NUL を含まないのでテキスト扱い (文字化けしても表示する)', () => {
    // 「あい」= 0x82 0xA0 0x82 0xA2。UTF-8 としては不正だが fatal 判定はしない。
    expect(looksBinary(bytes(0x82, 0xa0, 0x82, 0xa2))).toBe(false)
  })

  it('末尾に NUL が 1 つあるだけでバイナリ', () => {
    expect(looksBinary(bytes(0x68, 0x69, 0x00))).toBe(true)
  })
})

describe('TEXT_HEAD_BYTES', () => {
  it('サーバーの PREVIEW_TEXT_LIMIT と同値', () => {
    expect(TEXT_HEAD_BYTES).toBe(65536)
  })
})
