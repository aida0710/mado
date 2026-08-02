import { describe, expect, it } from 'vitest'
import { explainStorageError } from './storageError.js'

// 方針: こちらで原因の解釈や助言は書かない。status とストレージが返した
// コード / 生メッセージだけを出す。
describe('explainStorageError', () => {
  it('NoSuchKey → 404。コードをそのまま出す', () => {
    const r = explainStorageError({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
    expect(r).toEqual({ status: 404, message: 'HTTP 404 — NoSuchKey' })
  })

  it('upstream 5xx → 502。HTTP status を頭に付ける', () => {
    const r = explainStorageError({ $metadata: { httpStatusCode: 503 }, message: 'Service Unavailable' })
    expect(r?.status).toBe(502)
    expect(r?.message).toBe('HTTP 503 — Service Unavailable')
  })

  // 403 は「キーが違う」のか「権限が足りない」のかで対処が変わる。
  // コードをそのまま出さないと切り分けられない。
  it('403 → コードと生メッセージをそのまま出す', () => {
    const r = explainStorageError({
      name: 'AccessDenied',
      message: 'Access Denied',
      $metadata: { httpStatusCode: 403 },
    })
    expect(r).toEqual({ status: 502, message: 'HTTP 403 — AccessDenied: Access Denied' })
  })

  it('コードと生メッセージが同じなら重ねない', () => {
    const r = explainStorageError({
      name: 'AccessDenied',
      message: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    })
    expect(r?.message).toBe('HTTP 403 — AccessDenied')
  })

  // requestId はストレージ側に問い合わせるときの手がかりになる。
  it('requestId があれば添える', () => {
    const r = explainStorageError({
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'abc123' },
    })
    expect(r?.message).toBe('HTTP 403 — AccessDenied — requestId=abc123')
  })

  // 実機 (R2 に不正な資格情報) で出た形。助言を足すと実態とずれるので出さない。
  it('$metadata が無くても $response 付きなら S3 由来として扱う', () => {
    const r = explainStorageError({
      name: 'InvalidArgument',
      message: 'Credential access key has length 21, should be 32',
      $response: { body: '...' },
    })
    expect(r?.message).toBe('InvalidArgument: Credential access key has length 21, should be 32')
  })

  // パーサの例外文がそのまま来る。原因を決めつけず、見たままを出す。
  it('XML パース失敗はパーサの文面をそのまま出す', () => {
    const r = explainStorageError({
      message: "Expected closing tag 'hr' instead of closing tag 'body'.:6:1",
    })
    expect(r?.message).toBe("Expected closing tag 'hr' instead of closing tag 'body'.:6:1")
    expect(r?.message).not.toMatch(/一時的|確認してください/)
  })

  it('明らかに S3 関連でないエラー → null (呼び出し元に判断委譲)', () => {
    expect(explainStorageError({ message: 'some random non-storage error' })).toBeNull()
    expect(explainStorageError(new Error('totally unrelated'))).toBeNull()
  })

  // SignatureDoesNotMatch は canonical request 全文を抱えることがある。
  it('長すぎるときは切り詰める', () => {
    const r = explainStorageError({
      $metadata: { httpStatusCode: 400 },
      message: 'x'.repeat(2000),
    })
    expect(r?.message.length).toBeLessThanOrEqual(401)
    expect(r?.message.endsWith('…')).toBe(true)
  })
})
