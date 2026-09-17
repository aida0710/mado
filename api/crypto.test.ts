import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCrypto } from './crypto.js'

const TEST_KEY = '0'.repeat(64)

describe('createCrypto', () => {
  it('鍵が短すぎれば throw する', () => {
    expect(() => createCrypto('abc')).toThrow(/64 hex chars/)
  })

  it('64 文字でも hex 以外の文字を含めば throw する', () => {
    expect(() => createCrypto('z'.repeat(64))).toThrow(/64 hex chars/)
  })

  it('空の鍵は throw する', () => {
    expect(() => createCrypto('')).toThrow(/64 hex chars/)
  })

  it('64 文字の hex 鍵を受け付ける', () => {
    expect(() => createCrypto(TEST_KEY)).not.toThrow()
  })

  it('randomBytes で作った 32 バイトの hex 鍵を受け付ける', () => {
    const key = randomBytes(32).toString('hex')
    expect(() => createCrypto(key)).not.toThrow()
  })
})

describe('encrypt と decrypt の往復', () => {
  const crypto = createCrypto(TEST_KEY)

  it('ASCII 文字列を暗号化して復号すると元に戻る', () => {
    const pt = 'hello world'
    const packed = crypto.encrypt(pt)
    expect(packed.startsWith('v1:')).toBe(true)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('空文字列でも往復できる', () => {
    const pt = ''
    const packed = crypto.encrypt(pt)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('マルチバイトの UTF-8 でも往復できる', () => {
    const pt = '日本語テスト 🎉 emoji αβγ'
    const packed = crypto.encrypt(pt)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('長い文字列でも往復できる', () => {
    const pt = 'x'.repeat(10_000)
    const packed = crypto.encrypt(pt)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('同じ平文でも暗号文は毎回変わる (IV がランダム)', () => {
    const pt = 'same input'
    const a = crypto.encrypt(pt)
    const b = crypto.encrypt(pt)
    expect(a).not.toBe(b)
    expect(crypto.decrypt(a)).toBe(pt)
    expect(crypto.decrypt(b)).toBe(pt)
  })

  it('randomBytes で作った鍵でも往復できる', () => {
    const key = randomBytes(32).toString('hex')
    const c = createCrypto(key)
    const pt = 'AKIAEXAMPLE12345'
    expect(c.decrypt(c.encrypt(pt))).toBe(pt)
  })
})

describe('decrypt が失敗するとき', () => {
  const crypto = createCrypto(TEST_KEY)

  it('暗号文を 1 バイト書き換えると復号で throw する', () => {
    const packed = crypto.encrypt('hello world')
    const [v, iv, tag, ct] = packed.split(':')
    const ctBuf = Buffer.from(ct, 'base64')
    // 最初のバイトの1ビットを反転する
    ctBuf[0] = ctBuf[0] ^ 0x01
    const tampered = `${v}:${iv}:${tag}:${ctBuf.toString('base64')}`
    expect(() => crypto.decrypt(tampered)).toThrow()
  })

  it('認証タグを書き換えると復号で throw する', () => {
    const packed = crypto.encrypt('hello world')
    const [v, iv, tag, ct] = packed.split(':')
    const tagBuf = Buffer.from(tag, 'base64')
    tagBuf[0] = tagBuf[0] ^ 0x01
    const tampered = `${v}:${iv}:${tagBuf.toString('base64')}:${ct}`
    expect(() => crypto.decrypt(tampered)).toThrow()
  })

  it('未対応のバージョンは復号で throw する', () => {
    const packed = crypto.encrypt('hello world')
    const parts = packed.split(':')
    parts[0] = 'v9'
    const bad = parts.join(':')
    expect(() => crypto.decrypt(bad)).toThrow(/unsupported version: v9/)
  })

  it('別の鍵で復号すると throw する', () => {
    const a = createCrypto(TEST_KEY)
    const b = createCrypto('1'.repeat(64))
    const packed = a.encrypt('secret')
    expect(() => b.decrypt(packed)).toThrow()
  })
})

describe('mask', () => {
  const crypto = createCrypto(TEST_KEY)

  it('空文字列のマスクは空', () => {
    expect(crypto.mask('')).toBe('')
  })

  it('2 文字は全部 * になる', () => {
    expect(crypto.mask('AB')).toBe('**')
  })

  it('8 文字は境界で、全部 * になる', () => {
    expect(crypto.mask('ABCDEFGH')).toBe('********')
  })

  it('9 文字以上は先頭 4 + … + 末尾 4 になる', () => {
    expect(crypto.mask('AKIAEXAMPLE12345')).toBe('AKIA…2345')
  })
})
