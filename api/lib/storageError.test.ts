import { describe, expect, it } from 'vitest'
import { explainStorageError } from './storageError.js'

describe('explainStorageError', () => {
  it('NoSuchKeyを秘密を含まない404へ変換する', () => {
    const r = explainStorageError({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
    expect(r).toEqual({ status: 404, message: 'storage object not found' })
  })

  it('upstream 5xx → 502。HTTP status を頭に付ける', () => {
    const r = explainStorageError({ $metadata: { httpStatusCode: 503 }, message: 'Service Unavailable' })
    expect(r?.status).toBe(502)
    expect(r?.message).toBe('storage service error')
  })

  it('403の生messageをclientへ漏らさない', () => {
    const r = explainStorageError({
      name: 'AccessDenied',
      message: 'Access Denied',
      $metadata: { httpStatusCode: 403 },
    })
    expect(r).toEqual({ status: 502, message: 'storage service error' })
  })

  // 実機 (R2 に不正な資格情報) で出た形。助言を足すと実態とずれるので出さない。
  it('$metadata が無くても $response 付きなら S3 由来として扱う', () => {
    const r = explainStorageError({
      name: 'InvalidArgument',
      message: 'Credential access key has length 21, should be 32',
      $response: { body: '...' },
    })
    expect(r?.message).toBe('storage request failed')
  })

  // パーサの例外文がそのまま来る。原因を決めつけず、見たままを出す。
  it('XML パース失敗はパーサの文面をそのまま出す', () => {
    const r = explainStorageError({
      message: "Expected closing tag 'hr' instead of closing tag 'body'.:6:1",
    })
    expect(r?.message).toBe('storage request failed')
  })

  it('明らかに S3 関連でないエラー → null (呼び出し元に判断委譲)', () => {
    expect(explainStorageError({ message: 'some random non-storage error' })).toBeNull()
    expect(explainStorageError(new Error('totally unrelated'))).toBeNull()
  })

  it('canonical requestを含み得る長文を返さない', () => {
    const r = explainStorageError({
      $metadata: { httpStatusCode: 400 },
      message: 'x'.repeat(2000),
    })
    expect(r?.message).toBe('storage request failed')
  })
})
